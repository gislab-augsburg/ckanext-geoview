/* global ckan, ol, OL_HELPERS, $, preload_resource */
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
      this.loadPreview();
    },

    showError: function(message) {
      this.el.html($('<div></div>').addClass('wcs-preview-error').text(message));
    },

    loadPreview: function() {
      var self = this;
      var resourceUrl = this.getResourceUrl();
      var coverageId = this.getRequestedCoverageId(resourceUrl);
      var serviceUrl = this.options.proxy_service_url || stripFragment(resourceUrl);

      if (isGetCoverageUrl(resourceUrl)) {
        this.fetchCoverage(resourceUrl).then(function(blob) {
          self.showCoverage(blob);
        }).catch(function(error) {
          self.showError(error.message || String(error));
        });
        return;
      }

      this.fetchXml(withParams(serviceUrl, {
        SERVICE: 'WCS',
        REQUEST: 'GetCapabilities',
        VERSION: '2.0.1'
      })).then(function(capabilities) {
        var coverage = self.selectCoverage(capabilities, coverageId);
        if (!coverage.id) {
          throw new Error('No WCS coverage found.');
        }
        return self.describeCoverage(serviceUrl, capabilities, coverage);
      }).then(function(context) {
        var url = self.buildGetCoverageUrl(serviceUrl, context);
        return self.fetchCoverage(url);
      }).then(function(blob) {
        self.showCoverage(blob);
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

    selectCoverage: function(capabilities, requestedCoverageId) {
      var coverage = {};
      var summaries = localElements(capabilities, 'CoverageSummary');
      var list = summaries.length ? summaries : localElements(capabilities, 'CoverageOfferingBrief');

      list.each(function(i, node) {
        var id = firstLocalText(node, ['CoverageId', 'Identifier', 'name']);
        if (!coverage.id && (!requestedCoverageId || id === requestedCoverageId)) {
          coverage.id = id;
          coverage.bbox = readWgs84Bbox(node);
        }
      });

      if (requestedCoverageId && !coverage.id) {
        throw new Error('Requested WCS coverage not found: ' + requestedCoverageId);
      }
      return coverage;
    },

    describeCoverage: function(serviceUrl, capabilities, coverage) {
      var self = this;
      var version = getWcsVersion(capabilities);
      var params = {
        SERVICE: 'WCS',
        REQUEST: 'DescribeCoverage',
        VERSION: version
      };
      params[version.indexOf('2.') === 0 ? 'COVERAGEID' : 'IDENTIFIERS'] = coverage.id;

      return this.fetchXml(withParams(serviceUrl, params)).then(function(description) {
        return {
          coverage: coverage,
          description: description,
          version: version,
          maxSize: self.previewMaxSize
        };
      });
    },

    buildGetCoverageUrl: function(serviceUrl, context) {
      var version = context.version;
      var description = context.description;
      var coverage = context.coverage;
      var envelope = readEnvelope(description) || {};
      var bbox = envelope.bbox || coverage.bbox;
      var size = previewSize(readGridSize(description), context.maxSize);
      var format = preferredFormat(description);
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
        if (size && envelope.gridAxisLabels) {
          params.SCALESIZE = [
            envelope.gridAxisLabels[0] + '(' + size[0] + ')',
            envelope.gridAxisLabels[1] + '(' + size[1] + ')'
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
        params.IDENTIFIERS = coverage.id;
        if (bbox) {
          params.BOUNDINGBOX = bbox.join(',') + (envelope.crs ? ',' + normalizeCrs(envelope.crs) : '');
        }
      }

      return withParams(serviceUrl, params);
    },

    showCoverage: function(blob) {
      var self = this;
      if (!ol.source.GeoTIFF || !ol.layer.WebGLTile) {
        this.showError('OpenLayers GeoTIFF rendering is not available.');
        return;
      }

      var source = new ol.source.GeoTIFF({
        sources: [{blob: blob}],
        convertToRGB: 'auto'
      });
      var coverageLayer = new ol.layer.WebGLTile({source: source});

      this.getBaseLayer().then(function(baseLayer) {
        var layers = baseLayer ? [baseLayer, coverageLayer] : [coverageLayer];
        var map = new ol.Map({
          target: 'map',
          layers: layers,
          controls: [
            new ol.control.ZoomSlider(),
            new ol.control.MousePosition()
          ],
          view: new ol.View({
            center: [0, 0],
            zoom: 2
          })
        });

        source.getView().then(function(viewOptions) {
          map.setView(new ol.View(viewOptions));
        }).catch(function() {
          map.getView().fit(
            ol.proj.transformExtent(OL_HELPERS.WORLD_BBOX, OL_HELPERS.EPSG4326, map.getView().getProjection()),
            {constrainResolution: false}
          );
        });
      }).catch(function() {
        self.showError('Could not initialize WCS preview map.');
      });
    },

    getBaseLayer: function() {
      if (!OL_HELPERS || !OL_HELPERS.createLayerFromConfig) {
        return Promise.resolve(null);
      }

      var mapConfig = $.extend({}, this.options.map_config || {});
      if (mapConfig.type === 'mapbox') {
        if (!mapConfig.map_id || !mapConfig.access_token) {
          return Promise.resolve(null);
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

      return OL_HELPERS.createLayerFromConfig(mapConfig, true).catch(function() {
        return null;
      });
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
  var width = size[0];
  var height = size[1];
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

function asciiBytes(text) {
  var bytes = [];
  for (var i = 0; i < text.length; i++) {
    bytes.push(text.charCodeAt(i));
  }
  return bytes;
}
