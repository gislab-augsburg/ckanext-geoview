/* global ckan, ol, OL_HELPERS, $, preload_resource, GeoTIFF */
// WCS preview module. Keeps WCS-specific GeoTIFF handling isolated from the
// existing generic OpenLayers viewer.

ckan.module('wcspreview', function(jQuery, _) {
  return {
    initialize: function() {
      jQuery.proxyAll(this, /_on/);
      this.el.ready(this._onReady);
    },

    _onReady: function() {
      this.el.empty();
      this.el.append($('<div></div>').attr('id', 'map'));

      this.previewMaxSize = parseInt(
        (this.options.map_config && this.options.map_config.wcs_preview_max_size) || 1024,
        10
      );
      this.coverages = [];
      this.coverageById = {};
      this.defaultOpacity = 1;
      this.reloadDelay = 350;
      this.reloadTimer = null;
      this.map = null;
      this.layerSwitcher = null;

      this.initializeMap();
    },

    showError: function(message) {
      this.el.html($('<div></div>').addClass('wcs-preview-error').text(message));
    },

    initializeMap: function() {
      var self = this;
      this.getBaseLayers().then(function(baseLayers) {
        var baseMapLayer = baseLayers[0];
        self.layerSwitcher = new ol.control.HilatsLayerSwitcher({
          layersLabel: 'Coverages'
        });
        self.map = new OL_HELPERS.LoggingMap({
          target: 'map',
          layers: baseLayers,
          controls: [
            new ol.control.ZoomSlider(),
            new ol.control.MousePosition(),
            self.layerSwitcher
          ],
          loadingDiv: false,
          loadingListener: function(isLoading) {
            self.layerSwitcher.isLoading(isLoading);
          },
          view: new ol.View({
            projection: baseMapLayer.getSource().getProjection() || OL_HELPERS.Mercator,
            extent: baseMapLayer.getExtent()
          })
        });

        self.map.getView().fit(
          baseMapLayer.getExtent() || ol.proj.transformExtent(OL_HELPERS.WORLD_BBOX, OL_HELPERS.EPSG4326, self.map.getView().getProjection()),
          {constrainResolution: false}
        );

        self.loadCapabilities();
      }).catch(function() {
        self.showError('Could not initialize WCS preview map.');
      });
    },

    loadCapabilities: function() {
      var self = this;
      var resourceUrl = this.getResourceUrl();
      var requestedCoverageId = this.getRequestedCoverageId(resourceUrl);
      var serviceUrl = this.options.proxy_service_url || stripFragment(resourceUrl);

      this.serviceUrl = serviceUrl;

      if (isGetCoverageUrl(resourceUrl)) {
        this.coverages = [{
          id: 'coverage',
          title: 'Coverage',
          selected: true,
          directUrl: resourceUrl,
          opacity: this.defaultOpacity
        }];
        this.coverageById.coverage = this.coverages[0];
        this.setCoverageVisible(this.coverages[0], true);
        return;
      }

      this.fetchXml(withParams(serviceUrl, {
        SERVICE: 'WCS',
        REQUEST: 'GetCapabilities'
      })).then(function(capabilities) {
        self.capabilities = capabilities;
        self.version = getWcsVersion(capabilities);
        self.coverages = self.readCoverages(capabilities, requestedCoverageId);
        if (!self.coverages.length) {
          throw new Error('No WCS coverage found.');
        }
        self.coverages.forEach(function(coverage) {
          self.coverageById[coverage.id] = coverage;
        });
        return Promise.all(self.coverages.map(function(coverage) {
          return self.describeCoverage(coverage);
        })).then(function() {
          fitCoveragesBbox(self.map, self.coverages);
          self.coverages.forEach(function(coverage) {
            self.setCoverageVisible(coverage, true);
          });
          self.map.on('moveend', function() {
            self.scheduleVisibleCoverageReloads();
          });
        });
      }).catch(function(error) {
        self.showError(error.message || String(error));
      });
    },

    getResourceUrl: function() {
      if (preload_resource && preload_resource.original_url) {
        return preload_resource.original_url;
      }
      if (preload_resource && preload_resource.url) {
        return preload_resource.url;
      }
      return this.options.proxy_url || this.options.proxy_service_url || '';
    },

    getRequestedCoverageId: function(resourceUrl) {
      var hashIndex = String(resourceUrl || '').indexOf('#');
      if (hashIndex < 0) {
        return null;
      }
      var fragment = String(resourceUrl).substring(hashIndex + 1);
      return decodeURIComponent(fragment || '').trim() || null;
    },

    fetchXml: function(url) {
      return fetch(url, {credentials: 'same-origin'}).then(function(response) {
        if (!response.ok) {
          throw new Error('WCS request failed: ' + response.status + ' ' + response.statusText);
        }
        return response.text();
      }).then(function(text) {
        return $.parseXML(text);
      });
    },

    fetchCoverage: function(url) {
      return fetch(url, {credentials: 'same-origin'}).then(function(response) {
        if (!response.ok) {
          throw new Error('WCS GetCoverage failed: ' + response.status + ' ' + response.statusText);
        }
        return response.arrayBuffer().then(function(buffer) {
          return extractGeoTiffBlob(buffer, response.headers.get('content-type'));
        });
      });
    },

    readCoverages: function(capabilities, requestedCoverageId) {
      var coverages = [];
      var defaultOpacity = this.defaultOpacity;
      var summaries = localElements(capabilities, 'CoverageSummary');
      var list = summaries.length ? summaries : localElements(capabilities, 'CoverageOfferingBrief');

      list.each(function(i, node) {
        var coverageId = firstLocalText(node, ['CoverageId']);
        var identifier = firstLocalText(node, ['Identifier']);
        var name = firstLocalText(node, ['name']);
        var id = coverageId || identifier || name;
        if (!id || (requestedCoverageId && !matchesCoverageId(requestedCoverageId, coverageId, identifier, name))) {
          return;
        }
        coverages.push({
          id: id,
          coverageId: coverageId,
          identifier: identifier,
          name: name,
          title: firstLocalText(node, ['Title', 'label']) || id,
          bbox: readWgs84Bbox(node),
          opacity: defaultOpacity,
          selected: false,
          loading: false,
          described: false,
          layer: null
        });
      });

      if (requestedCoverageId && !coverages.length) {
        throw new Error('Requested WCS coverage not found: ' + requestedCoverageId);
      }
      return coverages;
    },

    describeCoverage: function(coverage) {
      if (coverage.describePromise) {
        return coverage.describePromise;
      }

      var version = this.version || '2.0.1';
      var params = {
        SERVICE: 'WCS',
        REQUEST: 'DescribeCoverage',
        VERSION: version
      };
      params[coverageIdParam(version)] = coverage.id;

      coverage.describePromise = this.fetchXml(withParams(this.serviceUrl, params)).then(function(description) {
        coverage.description = description;
        coverage.envelope = readEnvelope(description) || {};
        coverage.gridSize = readGridSize(description);
        coverage.format = preferredFormat(description);
        coverage.described = true;
        return coverage;
      });

      return coverage.describePromise;
    },

    setCoverageVisible: function(coverage, visible) {
      coverage.selected = visible;

      if (!visible) {
        if (coverage.layer) {
          coverage.layer.setVisible(false);
        }
        return;
      }

      if (coverage.layer) {
        coverage.layer.setVisible(true);
        return;
      }

      this.loadCoverageForCurrentView(coverage);
    },

    loadCoverageForCurrentView: function(coverage) {
      var self = this;
      var url;

      if (coverage.loading) {
        return;
      }

      coverage.loading = true;
      coverage.error = null;

      var loadPromise;
      if (coverage.directUrl) {
        url = coverage.directUrl;
        loadPromise = Promise.resolve(coverage);
      } else {
        loadPromise = this.describeCoverage(coverage).then(function(describedCoverage) {
          url = self.buildGetCoverageUrl(describedCoverage);
          return describedCoverage;
        });
      }

      loadPromise.then(function(describedCoverage) {
        return self.fetchCoverage(url).then(function(blob) {
          return self.createCoverageLayer(blob, describedCoverage.opacity).then(function(layer) {
            self.replaceCoverageLayer(describedCoverage, layer);
          });
        });
      }).catch(function(error) {
        coverage.error = error.message || String(error);
      }).then(function() {
        coverage.loading = false;
      });
    },

    buildGetCoverageUrl: function(coverage) {
      var version = this.version || '2.0.1';
      var envelope = coverage.envelope || {};
      var bbox = this.getCoverageRequestBbox(coverage);
      var size = this.getRequestSize(coverage, bbox);
      var format = coverage.format || 'image/tiff';
      var params = {
        SERVICE: 'WCS',
        REQUEST: 'GetCoverage',
        VERSION: version,
        FORMAT: format
      };

      if (version.indexOf('2.') === 0) {
        params.COVERAGEID = coverage.id;
        if (bbox) {
          var axes = envelope.axisLabels || ['x', 'y'];
          params.SUBSET = [
            axes[0] + '(' + bbox[0] + ',' + bbox[2] + ')',
            axes[1] + '(' + bbox[1] + ',' + bbox[3] + ')'
          ];
        }
        if (size) {
          var gridAxes = envelope.gridAxisLabels || envelope.axisLabels || ['x', 'y'];
          params.SCALESIZE = [
            gridAxes[0] + '(' + size[0] + ')',
            gridAxes[1] + '(' + size[1] + ')'
          ].join(',');
        }
      } else if (version.indexOf('1.0') === 0) {
        params.COVERAGE = coverage.id;
        params.FORMAT = format === 'image/tiff' ? 'GeoTIFF' : format;
        if (bbox) {
          params.BBOX = bbox.join(',');
        }
        if (envelope.crs) {
          params.CRS = normalizeCrs(envelope.crs);
        }
        if (size) {
          params.WIDTH = size[0];
          params.HEIGHT = size[1];
        }
      } else {
        params.IDENTIFIER = coverage.id;
        if (bbox) {
          params.BOUNDINGBOX = bbox.join(',') + (envelope.crs ? ',' + normalizeCrs(envelope.crs) : '');
        }
      }

      return withParams(this.serviceUrl, params);
    },

    getCoverageRequestBbox: function(coverage) {
      var envelope = coverage.envelope || {};
      return this.getViewportBbox(envelope) || envelope.bbox || coverage.bbox;
    },

    getViewportBbox: function(envelope) {
      if (!this.map || !this.map.getView()) {
        return null;
      }

      var view = this.map.getView();
      var size = this.map.getSize();
      var extent = size && view.calculateExtent(size);
      if (!extent) {
        return null;
      }

      var sourceProjection = view.getProjection();
      var targetProjection = envelope.crs && ol.proj.get(normalizeCrs(envelope.crs));
      if (targetProjection && sourceProjection && sourceProjection.getCode() !== targetProjection.getCode()) {
        extent = ol.proj.transformExtent(extent, sourceProjection, targetProjection);
      }

      if (envelope.bbox) {
        extent = intersectBbox(extent, envelope.bbox);
      }
      return extent;
    },

    getRequestSize: function(coverage, bbox) {
      var mapSize = this.map && this.map.getSize && this.map.getSize();
      if (mapSize && bbox) {
        return constrainSize(mapSize[0], mapSize[1], this.previewMaxSize);
      }
      return previewSize(coverage.gridSize, this.previewMaxSize);
    },

    createCoverageLayer: function(blob, opacity) {
      var self = this;
      return getGeoTiffSourceInfo(blob).then(function(sourceInfo) {
        return detectNoData(blob).then(function(nodata) {
          if (nodata !== null && nodata !== undefined && !isNaN(nodata)) {
            sourceInfo.nodata = parseFloat(nodata);
          }
          return sourceInfo;
        });
      }).then(function(sourceInfo) {

        var source = new ol.source.GeoTIFF({
          sources: [sourceInfo],
          convertToRGB: 'auto'
        });
        return new ol.layer.WebGLTile({
          title: null,
          type: 'overlay',
          source: source,
          opacity: opacity,
          visible: true
        });
      }).catch(function() {
        self.showError('OpenLayers could not create a WCS GeoTIFF layer.');
      });
    },

    replaceCoverageLayer: function(coverage, layer) {
      if (!layer) {
        return;
      }

      layer.set('title', coverage.title || coverage.id);
      layer.set('type', 'overlay');

      var visible = !coverage.layer || coverage.layer.getVisible();
      if (coverage.layer) {
        if (coverage.visibilityListenerKey) {
          ol.Observable.unByKey(coverage.visibilityListenerKey);
        }
        this.map.removeLayer(coverage.layer);
      }

      coverage.layer = layer;
      coverage.layer.setVisible(visible);
      this.bindCoverageVisibility(coverage);
      this.map.addLayer(layer);
    },

    bindCoverageVisibility: function(coverage) {
      var self = this;
      coverage.visibilityListenerKey = coverage.layer.on('change:visible', function() {
        coverage.selected = coverage.layer.getVisible();
        if (coverage.selected && !coverage.directUrl) {
          self.loadCoverageForCurrentView(coverage);
        }
      });
    },

    scheduleVisibleCoverageReloads: function() {
      var self = this;
      window.clearTimeout(this.reloadTimer);
      this.reloadTimer = window.setTimeout(function() {
        self.coverages.forEach(function(coverage) {
          if (self.isCoverageVisible(coverage) && !coverage.directUrl) {
            self.loadCoverageForCurrentView(coverage);
          }
        });
      }, this.reloadDelay);
    },

    isCoverageVisible: function(coverage) {
      return !!(coverage.layer && coverage.layer.getVisible());
    },

    getBaseLayers: function() {
      if (!OL_HELPERS || !OL_HELPERS.createLayerFromConfig) {
        return Promise.reject('OpenLayers helpers are not available.');
      }

      var mapConfig = $.extend({}, this.options.map_config || {});
      var baseMapsConfig = this.options.basemapsConfig;
      var self = this;

      if (!baseMapsConfig) {
        var config = {
          type: mapConfig.type
        };
        if (config.type) {
          var prefix = config.type + '.';
          for (var fieldName in mapConfig) {
            if (fieldName.startsWith(prefix)) {
              config[fieldName.substring(prefix.length)] = mapConfig[fieldName];
            }
          }
        }
        baseMapsConfig = [config];
      }

      return this.createBaseLayer(baseMapsConfig[0]).then(function(firstLayerList) {
        var layers = firstLayerList.slice();
        layers.forEach(function(layer) {
          layer.set('baseLayerOrder', 0);
        });
        var remaining = baseMapsConfig.slice(1).map(function(config) {
          var baseMapIndex = baseMapsConfig.indexOf(config);
          return self.createBaseLayer(config).then(function(layerList) {
            layerList.forEach(function(layer) {
              layer.set('baseLayerOrder', baseMapIndex);
              layer.setVisible(false);
              layers.push(layer);
            });
          });
        });

        return Promise.all(remaining).then(function() {
          return layers;
        });
      });
    },

    createBaseLayer: function(mapConfig) {
      mapConfig = $.extend({}, mapConfig || {});
      if (mapConfig.type === 'mapbox') {
        if (!mapConfig.map_id || !mapConfig.access_token) {
          return Promise.reject('MapBox base map requires a map_id and access_token.');
        }
        mapConfig.url = [
          '//a.tiles.mapbox.com/v4/' + mapConfig.map_id + '/${z}/${x}/${y}.png?access_token=' + mapConfig.access_token,
          '//b.tiles.mapbox.com/v4/' + mapConfig.map_id + '/${z}/${x}/${y}.png?access_token=' + mapConfig.access_token,
          '//c.tiles.mapbox.com/v4/' + mapConfig.map_id + '/${z}/${x}/${y}.png?access_token=' + mapConfig.access_token,
          '//d.tiles.mapbox.com/v4/' + mapConfig.map_id + '/${z}/${x}/${y}.png?access_token=' + mapConfig.access_token
        ];
        mapConfig.attribution = '<a href="https://www.mapbox.com/about/maps/" target="_blank">&copy; Mapbox &copy; OpenStreetMap </a>';
      } else if (mapConfig.type === 'custom') {
        mapConfig.type = 'XYZ';
      } else if (!mapConfig.type) {
        mapConfig.type = 'OSM';
      }

      return OL_HELPERS.createLayerFromConfig(mapConfig, true);
    }
  };
});

function stripFragment(url) {
  return String(url || '').split('#')[0];
}

function isGetCoverageUrl(url) {
  return /(?:\?|&)request=getcoverage(?:&|$)/i.test(stripFragment(url));
}

function withParams(url, params) {
  var parts = stripFragment(url).split('?');
  var base = parts[0];
  var query = new URLSearchParams(parts[1] || '');

  Object.keys(params).forEach(function(key) {
    query.delete(key);
    query.delete(key.toLowerCase());
    var value = params[key];
    if (Array.isArray(value)) {
      value.forEach(function(item) {
        query.append(key, item);
      });
    } else if (value !== undefined && value !== null && value !== '') {
      query.set(key, value);
    }
  });

  return base + '?' + query.toString();
}

function localElements(root, name) {
  return $(root).find('*').filter(function() {
    return this.localName === name || this.nodeName.split(':').pop() === name;
  });
}

function firstLocalText(root, names) {
  for (var i = 0; i < names.length; i++) {
    var found = localElements(root, names[i]).first();
    if (found.length) {
      return $.trim(found.text());
    }
  }
  return '';
}

function matchesCoverageId(requestedCoverageId, coverageId, identifier, name) {
  return requestedCoverageId === coverageId ||
    requestedCoverageId === identifier ||
    requestedCoverageId === name;
}

function coverageIdParam(version) {
  if (version.indexOf('2.') === 0) {
    return 'COVERAGEID';
  }
  if (version.indexOf('1.0') === 0) {
    return 'COVERAGE';
  }
  return 'IDENTIFIER';
}

function getWcsVersion(capabilities) {
  return $(capabilities).find('*').first().attr('version') || '2.0.1';
}

function readWgs84Bbox(node) {
  var bboxNode = localElements(node, 'WGS84BoundingBox').first();
  if (!bboxNode.length) {
    return null;
  }
  return cornersToBbox(
    firstLocalText(bboxNode, ['LowerCorner']).split(/\s+/),
    firstLocalText(bboxNode, ['UpperCorner']).split(/\s+/)
  );
}

function readEnvelope(xml) {
  var envelope = localElements(xml, 'Envelope').first();
  if (!envelope.length) {
    return null;
  }

  var lower = firstLocalText(envelope, ['lowerCorner']).split(/\s+/);
  var upper = firstLocalText(envelope, ['upperCorner']).split(/\s+/);
  var axisLabels = (envelope.attr('axisLabels') || '').split(/\s+/).filter(Boolean);
  var gridAxisLabels = firstLocalText(xml, ['axisLabels']).split(/\s+/).filter(Boolean);

  return {
    bbox: cornersToBbox(lower, upper),
    crs: envelope.attr('srsName') || '',
    axisLabels: axisLabels.length >= 2 ? axisLabels : null,
    gridAxisLabels: gridAxisLabels.length >= 2 ? gridAxisLabels : null
  };
}

function cornersToBbox(lower, upper) {
  if (lower.length < 2 || upper.length < 2) {
    return null;
  }
  return [
    parseFloat(lower[0]),
    parseFloat(lower[1]),
    parseFloat(upper[0]),
    parseFloat(upper[1])
  ];
}

function readGridSize(xml) {
  var low = firstLocalText(xml, ['low']).split(/\s+/).map(function(value) {
    return parseInt(value, 10);
  });
  var high = firstLocalText(xml, ['high']).split(/\s+/).map(function(value) {
    return parseInt(value, 10);
  });

  if (low.length < 2 || high.length < 2 || isNaN(high[0]) || isNaN(high[1])) {
    return null;
  }

  return [high[0] - (low[0] || 0) + 1, high[1] - (low[1] || 0) + 1];
}

function previewSize(size, maxSize) {
  if (!size) {
    return null;
  }
  return constrainSize(size[0], size[1], maxSize);
}

function constrainSize(width, height, maxSize) {
  var scale = Math.min(1, maxSize / Math.max(width, height));
  return [
    Math.max(1, Math.round(width * scale)),
    Math.max(1, Math.round(height * scale))
  ];
}

function preferredFormat(xml) {
  var formats = [];
  localElements(xml, 'formatSupported').each(function(i, node) {
    formats.push($.trim($(node).text()).toLowerCase());
  });
  localElements(xml, 'supportedFormat').each(function(i, node) {
    formats.push($.trim($(node).text()).toLowerCase());
  });

  if (formats.indexOf('image/tiff') >= 0) {
    return 'image/tiff';
  }
  if (formats.indexOf('geotiff') >= 0) {
    return 'geotiff';
  }
  return 'image/tiff';
}

function normalizeCrs(crs) {
  var match = String(crs || '').match(/EPSG(?:::|\/0\/|:)(\d+)/i);
  return match ? 'EPSG:' + match[1] : crs;
}

function intersectBbox(a, b) {
  if (!a || !b) {
    return a || b || null;
  }
  var bbox = [
    Math.max(a[0], b[0]),
    Math.max(a[1], b[1]),
    Math.min(a[2], b[2]),
    Math.min(a[3], b[3])
  ];
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    return b;
  }
  return bbox;
}

function fitCoveragesBbox(map, coverages) {
  var view = map && map.getView && map.getView();
  if (!view) {
    return;
  }

  var extent = null;
  coverages.forEach(function(coverage) {
    var projected = coverageProjectedBbox(coverage, view.getProjection());
    if (projected) {
      extent = extent ? [
        Math.min(extent[0], projected[0]),
        Math.min(extent[1], projected[1]),
        Math.max(extent[2], projected[2]),
        Math.max(extent[3], projected[3])
      ] : projected;
    }
  });

  if (!extent) {
    return;
  }

  view.fit(extent, {
    size: map.getSize(),
    constrainResolution: false,
    nearest: false
  });
}

function coverageProjectedBbox(coverage, targetProjection) {
  var envelope = coverage.envelope || {};
  var bbox = envelope.bbox || coverage.bbox;
  if (!bbox) {
    return null;
  }

  var sourceProjection = envelope.crs && ol.proj.get(normalizeCrs(envelope.crs));

  if (sourceProjection && targetProjection && sourceProjection.getCode() !== targetProjection.getCode()) {
    return ol.proj.transformExtent(bbox, sourceProjection, targetProjection);
  }
  if (!sourceProjection && targetProjection && targetProjection.getCode() !== OL_HELPERS.EPSG4326.getCode()) {
    return ol.proj.transformExtent(bbox, OL_HELPERS.EPSG4326, targetProjection);
  }

  return bbox;
}

function extractGeoTiffBlob(buffer, contentType) {
  var bytes = new Uint8Array(buffer);
  var start = findTiffStart(bytes);
  if (start < 0) {
    throw new Error('WCS response did not contain a GeoTIFF payload.');
  }

  var end = findMultipartBoundary(bytes, start, contentType || '') || bytes.length;
  return new Blob([buffer.slice(start, end)], {type: 'image/tiff'});
}

function findTiffStart(bytes) {
  for (var i = 0; i < bytes.length - 3; i++) {
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2a && bytes[i + 3] === 0x00) {
      return i;
    }
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x2a) {
      return i;
    }
    if (bytes[i] === 0x49 && bytes[i + 1] === 0x49 && bytes[i + 2] === 0x2b && bytes[i + 3] === 0x00) {
      return i;
    }
    if (bytes[i] === 0x4d && bytes[i + 1] === 0x4d && bytes[i + 2] === 0x00 && bytes[i + 3] === 0x2b) {
      return i;
    }
  }
  return -1;
}

function findMultipartBoundary(bytes, start, contentType) {
  var match = contentType.match(/boundary="?([^";]+)"?/i);
  if (!match) {
    return null;
  }
  var boundary = asciiBytes('\r\n--' + match[1]);
  for (var i = start + 4; i <= bytes.length - boundary.length; i++) {
    var found = true;
    for (var j = 0; j < boundary.length; j++) {
      if (bytes[i + j] !== boundary[j]) {
        found = false;
        break;
      }
    }
    if (found) {
      return i;
    }
  }
  return null;
}

function detectNoData(blob) {
  if (typeof GeoTIFF === 'undefined' || !GeoTIFF.fromBlob) {
    return Promise.resolve(null);
  }
  return GeoTIFF.fromBlob(blob).then(function(tiff) {
    return tiff.getImage();
  }).then(function(image) {
    if (!image || !image.getGDALNoData) {
      return null;
    }
    return image.getGDALNoData();
  }).catch(function() {
    return null;
  });
}

function getGeoTiffSourceInfo(blob) {
  var sourceInfo = {blob: blob};
  if (typeof GeoTIFF === 'undefined' || !GeoTIFF.fromBlob) {
    return Promise.resolve(sourceInfo);
  }

  return GeoTIFF.fromBlob(blob).then(function(tiff) {
    return tiff.getImage();
  }).then(function(image) {
    if (!image || !image.getSamplesPerPixel) {
      return sourceInfo;
    }

    var samples = image.getSamplesPerPixel();
    if (samples <= 2) {
      sourceInfo.bands = [1];
    } else {
      sourceInfo.bands = [1, 2, 3];
    }
    return sourceInfo;
  }).catch(function() {
    return sourceInfo;
  });
}

function asciiBytes(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i));
  }
  return bytes;
}
