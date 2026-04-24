// wmts preview module
ckan.module('wmtskvppreview', function (jQuery, _) {
  return {
    initialize: function () {
      var self = this;

      self.el.empty();
      self.el.append($('<div></div>').attr('id', 'map'));

      var proxyUrlOption = this.options.proxy_url;
      if (proxyUrlOption && typeof proxyUrlOption !== 'string') {
        proxyUrlOption = String(proxyUrlOption);
      }

      var serviceProxyUrlOption = this.options.proxy_service_url;
      if (serviceProxyUrlOption && typeof serviceProxyUrlOption !== 'string') {
        serviceProxyUrlOption = String(serviceProxyUrlOption);
      }

      if (!serviceProxyUrlOption && preload_resource && preload_resource.url && /\/service_proxy(?:\?|$)/.test(preload_resource.url)) {
        serviceProxyUrlOption = String(preload_resource.url).replace(/([?&].*)?$/, '');
      }

      if (!serviceProxyUrlOption && preload_resource && preload_resource.url && /\/proxy(?:\?|$)/.test(preload_resource.url)) {
        serviceProxyUrlOption = preload_resource.url.replace(/\/proxy(?:\?.*)?$/, '/service_proxy');
      }

      if (!serviceProxyUrlOption && preload_resource && preload_resource.url) {
        var spMatch = String(preload_resource.url).match(/^(.*\/service_proxy)(?:[?&].*)?$/);
        if (spMatch) {
          serviceProxyUrlOption = spMatch[1];
        }
      }

      var effectiveProxyUrl = proxyUrlOption;
      if (!effectiveProxyUrl && serviceProxyUrlOption) {
        effectiveProxyUrl = serviceProxyUrlOption.replace(/\/service_proxy$/, '/proxy');
      }
      if (!effectiveProxyUrl && preload_resource && preload_resource.url) {
        var proxyMatch = preload_resource.url.match(/^(.*\/proxy)(?:\?|$)/);
        if (proxyMatch) {
          effectiveProxyUrl = proxyMatch[1];
        }
      }

      self.serviceProxyUrl = serviceProxyUrlOption || null;

      console.log('WMTS KVP DEBUG this.options=', this.options);
      console.log('WMTS KVP DEBUG preload_resource.url=', preload_resource && preload_resource['url']);
      console.log('WMTS KVP DEBUG proxyUrlOption=', proxyUrlOption);
      console.log('WMTS KVP DEBUG serviceProxyUrlOption=', serviceProxyUrlOption);
      console.log('WMTS KVP DEBUG effectiveProxyUrl=', effectiveProxyUrl);
      console.log('WMTS KVP DEBUG self.serviceProxyUrl=', self.serviceProxyUrl);

      self.proxifyUrl = function (targetUrl) {
        if (!targetUrl) return targetUrl;
        if (/\/dataset\/.*\/resource\/.*\/proxy(?:\?|$)/.test(targetUrl)) return targetUrl;
        if (effectiveProxyUrl) {
          return effectiveProxyUrl + '?url=' + encodeURIComponent(targetUrl);
        }
        return targetUrl;
      };

      var capabilitiesBaseUrl = self.serviceProxyUrl || (preload_resource && preload_resource['url'] ? String(preload_resource['url']).replace(/([?&].*)?$/, '') : '');
      var capabilitiesUrl = capabilitiesBaseUrl + (capabilitiesBaseUrl.indexOf('?') >= 0 ? '' : '?') + 'SERVICE=WMTS&REQUEST=GetCapabilities&VERSION=1.0.0';
      console.log('WMTS KVP DEBUG capabilitiesBaseUrl=', capabilitiesBaseUrl);
      console.log('WMTS KVP DEBUG capabilitiesUrl=', capabilitiesUrl);

      jQuery.ajax({
        url: capabilitiesUrl,
        dataType: 'text'
      }).done(
        function(data){
          self.showPreview(data);
        })
      .fail(
        function(jqXHR, textStatus, errorThrown) {
          self.showError(jqXHR, textStatus, errorThrown);
        }
      );
    },

    showError: function (jqXHR, textStatus, errorThrown) {
      if (textStatus == 'error' && jqXHR.responseText.length) {
        this.el.html(jqXHR.responseText);
      } else {
        this.el.html(this.i18n('error', {text: textStatus, error: errorThrown}));
      }
    },

    showPreview: function (wmtsInfo) {
      var self = this;
      var EPSG4326 = proj4('EPSG:4326');
      var xmlPathPrefix = 'Contents Layer';
      var nameSpace = ($(wmtsInfo).find('ows\\:Identifier').length != 0) ? 'ows\\:' : '';
      var tileUrlPrefix = $(wmtsInfo).find(nameSpace + 'Operation[name="GetTile"]').find(nameSpace + 'Get:contains("KVP")').attr('xlink:href');
      var bboxName;
      var mapInfos = [];
      var maps = {};
      var mapLatLngBounds = {};
      var overlay;
      var matrixSets = {};

      function httpify(s) {
        if (s != undefined) {
          if (!s.match(/^[a-zA-Z]+:\/\//)) s = window.location.protocol + '//' + s;
        }
        return s;
      }

      function layerChange(e) {
        overlay = e.layer;
      }

      function loadScript(url, callback) {
        var script = document.createElement('script');
        script.src = url;
        script.onreadystatechange = callback;
        script.onload = callback;
        document.getElementsByTagName('head')[0].appendChild(script);
      }

      function loadEPSG(url, epsgCode, callback) {
        jQuery.ajax({
          url: url,
          dataType: 'text'
        }).done(function(definition) {
          if (proj4 && epsgCode && definition) {
            proj4.defs(epsgCode, jQuery.trim(definition));
          }
          callback();
        }).fail(function() {
          callback();
        });
      }

      function ensureProj4Leaflet(callback) {
        if (L.Proj && L.Proj.CRS) {
          callback();
          return;
        }
        var base = self.options.site_url || '/';
        if (base.substr(base.length - 1) !== '/') {
          base += '/';
        }
        loadScript(base + 'js/vendor/proj4leaflet/proj4leaflet.js', callback);
      }

      function transCoord(x, y, userCrs) {
        var p = [parseFloat(x), parseFloat(y)];
        if (proj4) {
          p = proj4(userCrs, EPSG4326, p);
        }
        return [p[1], p[0]];
      }

      function normalizeCrs(crsText) {
        if (!crsText) return '';
        var match = crsText.match(/EPSG(?:::|:)(\d+)/i);
        if (match) return 'EPSG:' + match[1];
        return crsText;
      }

      function normalizeMatrixSetName(name) {
        if (!name) return '';
        return String(name).toLowerCase().replace(/[_-]?\d+(?:-\d+)?$/, '');
      }

      function parseBoolOption(value, defaultValue) {
        if (value === undefined || value === null || value === '') return defaultValue;
        if (typeof value === 'boolean') return value;
        if (typeof value === 'string') return value.toLowerCase() === 'true';
        return !!value;
      }

      function parseKeywordOption(value) {
        if (value === undefined || value === null || value === true) {
          value = '';
        }
        if (Array.isArray(value)) return value;
        return String(value).split(',').map(function(item) {
          return item.trim().toLowerCase();
        }).filter(function(item) { return item.length > 0; });
      }

      var wmtsConfig = (this.options && this.options.map_config) ? this.options.map_config : {};
      var wmtsMatrixsetAutoSelect = parseBoolOption(wmtsConfig.wmts_matrixset_auto_select, false);
      var wmtsMatrixsetPreferredKeywords = parseKeywordOption(wmtsConfig.wmts_matrixset_preferred_keywords);
      var wmtsMatrixsetHideBasemapIfIncompatible = parseBoolOption(wmtsConfig.wmts_matrixset_hide_basemap_if_incompatible, false);
      var wmtsMatrixsetRequireXyzGrid = parseBoolOption(wmtsConfig.wmts_matrixset_require_xyz_grid, false);

      function getMatrixInfo(matrixSetId) {
        if (!matrixSetId) return null;
        if (matrixSets[matrixSetId]) return matrixSets[matrixSetId];

        var normalized = normalizeMatrixSetName(matrixSetId);
        var fallback = null;

        jQuery.each(matrixSets, function(id, info) {
          if (normalizeMatrixSetName(id) === normalized) {
            fallback = info;
            return false;
          }
        });

        return fallback;
      }

      function isStandardWebMercatorGrid(matrixInfo) {
        if (!matrixInfo) return false;
        var crs = normalizeCrs(matrixInfo.supportedCrs || matrixInfo.code);
        var first = matrixInfo.firstTileMatrix || {};
        var tlc = first.topLeftCorner || [];
        var width = first.matrixWidth;
        var height = first.matrixHeight;

        if (!(crs === 'EPSG:3857' || crs === 'EPSG:900913' || crs === 'EPSG:102100' || crs === 'EPSG:102113')) {
          return false;
        }
        if (!(width === 1 && height === 1)) {
          return false;
        }
        if (tlc.length !== 2) {
          return false;
        }

        return Math.abs(tlc[0] + 20037508.342789244) < 1 &&
               Math.abs(tlc[1] - 20037508.342789244) < 1;
      }

      function matrixSetCompatibilityScore(matrixSetId) {
        var matrixInfo = getMatrixInfo(matrixSetId);
        if (!matrixInfo) return 0;

        var id = (matrixInfo.id || '').toLowerCase();
        var title = (matrixInfo.title || '').toLowerCase();
        var wellKnownScaleSet = (matrixInfo.wellKnownScaleSet || '').toLowerCase();

        if (!wmtsMatrixsetAutoSelect) {
          return 0;
        }

        for (var i = 0; i < wmtsMatrixsetPreferredKeywords.length; i++) {
          var kw = wmtsMatrixsetPreferredKeywords[i];
          if (id.indexOf(kw) >= 0 || title.indexOf(kw) >= 0 || wellKnownScaleSet.indexOf(kw) >= 0) {
            return 900 - i;
          }
        }

        if (wmtsMatrixsetRequireXyzGrid && isStandardWebMercatorGrid(matrixInfo)) {
          return 100;
        }

        if (!wmtsMatrixsetRequireXyzGrid && isStandardWebMercatorGrid(matrixInfo)) {
          return 100;
        }

        return 0;
      }

      function chooseMatrixSet(linkedMatrixSets) {
        console.log('WMTS KVP DEBUG linkedMatrixSets=', linkedMatrixSets);
        if (!wmtsMatrixsetAutoSelect) {
          console.log('WMTS KVP DEBUG auto-select disabled, keeping first matrix set=', linkedMatrixSets.length ? linkedMatrixSets[0] : '');
          return linkedMatrixSets.length ? linkedMatrixSets[0] : '';
        }

        var bestId = linkedMatrixSets.length ? linkedMatrixSets[0] : '';
        var bestScore = -1;

        jQuery.each(linkedMatrixSets, function(i, matrixSetId) {
          var score = matrixSetCompatibilityScore(matrixSetId);
          console.log('WMTS KVP DEBUG matrixSet score=', matrixSetId, score, getMatrixInfo(matrixSetId));
          if (score > bestScore) {
            bestScore = score;
            bestId = matrixSetId;
          }
        });

        console.log('WMTS KVP DEBUG chosen matrix set=', bestId, 'score=', bestScore);
        return bestId;
      }

      function chosenMatrixSetSupportsBasemap(matrixSetId) {
        if (!wmtsMatrixsetAutoSelect) return true;
        return matrixSetCompatibilityScore(matrixSetId) > 0;
      }

      function metersPerUnitFor(crsCode) {
        if (crsCode === 'EPSG:4326') return 111319.49079327358;
        return 1;
      }

      function matrixInfoToLeafletOptions(matrixInfo) {
        return {
          crsCode: matrixInfo.code,
          origin: matrixInfo.topLeftCorner,
          resolutions: matrixInfo.resolutions,
          tileMatrixLabels: matrixInfo.labels,
          projectedBounds: matrixInfo.projectedBounds
        };
      }

      function createMapForLayer(firstMapInfo, callback) {
        var matrixInfo = getMatrixInfo(firstMapInfo.tileMatrixSet);
        var crsCode = matrixInfo && normalizeCrs(matrixInfo.code);
        var isStandard3857 = crsCode === 'EPSG:3857' || crsCode === 'EPSG:900913' || crsCode === 'EPSG:102100' || crsCode === 'EPSG:102113';
        var useBasemap = true;
        console.log('WMTS KVP DEBUG first chosen tileMatrixSet=', firstMapInfo.tileMatrixSet);
        if (wmtsMatrixsetAutoSelect && wmtsMatrixsetHideBasemapIfIncompatible) {
          useBasemap = chosenMatrixSetSupportsBasemap(firstMapInfo.tileMatrixSet);
        }
        console.log('WMTS KVP DEBUG createMap useBasemap=', useBasemap);

        if (isStandard3857 || !matrixInfo) {
          if (useBasemap) {
            self.map = ckan.commonLeafletMap('map', self.options.map_config, {attributionControl: false, center: [0, 0], zoom: 3});
          } else {
            self.map = new L.Map('map', {attributionControl: false, center: [0, 0], zoom: 3});
          }
          callback();
          return;
        }

        var leafletOptions = matrixInfoToLeafletOptions(matrixInfo);

        function initCustomMap() {
          if (!L.Proj || !L.Proj.CRS) {
            self.showError({responseText: 'Proj4Leaflet not available for WMTS CRS ' + leafletOptions.crsCode}, 'error', 'Missing Proj4Leaflet');
            return;
          }

          if (self.map && self.map.remove) {
            self.map.remove();
          }
          $('#map').empty();

          var crsOptions = {
            origin: leafletOptions.origin,
            resolutions: leafletOptions.resolutions
          };
          if (leafletOptions.projectedBounds) {
            crsOptions.bounds = L.bounds(leafletOptions.projectedBounds[0], leafletOptions.projectedBounds[1]);
          }

          var crs = new L.Proj.CRS(
            leafletOptions.crsCode,
            proj4.defs(leafletOptions.crsCode),
            crsOptions
          );

          self.map = new L.Map('map', {
            attributionControl: false,
            center: [0, 0],
            zoom: 0,
            crs: crs,
            maxBounds: mapLatLngBounds[firstMapInfo.id]
          });

          callback();
        }

        if (!proj4.defs(leafletOptions.crsCode)) {
          var epsgNum = leafletOptions.crsCode.replace(/^EPSG:/, '');
          loadEPSG(window.location.protocol + '//epsg.io/' + epsgNum + '.proj4', leafletOptions.crsCode, function() {
            ensureProj4Leaflet(initCustomMap);
          });
        } else {
          ensureProj4Leaflet(initCustomMap);
        }
      }

      if ($(wmtsInfo).find(nameSpace + 'WGS84BoundingBox').length != 0) {
        bboxName = 'WGS84BoundingBox';
      } else if ($(wmtsInfo).find(nameSpace + 'BoundingBox').length != 0) {
        bboxName = 'BoundingBox';
      } else {
        bboxName = '';
      }

      $(wmtsInfo).find('TileMatrixSet').filter(function() {
        return $(this).children(nameSpace + 'SupportedCRS').length > 0;
      }).each(function(i, selectedElement) {
        var supportedCrs = normalizeCrs($(selectedElement).find(nameSpace + 'SupportedCRS').first().text());
        var metersPerUnit = metersPerUnitFor(supportedCrs);
        var labels = [];
        var resolutions = [];
        var topLeftCorner = null;
        var minX = null, minY = null, maxX = null, maxY = null;

        $(selectedElement).find('TileMatrix').each(function(j, tm) {
          var label = $(tm).find(nameSpace + 'Identifier').first().text();
          var scaleDenominator = parseFloat($(tm).find('ScaleDenominator').first().text());
          var topLeftText = $(tm).find('TopLeftCorner').first().text();
          var tlc = topLeftText ? topLeftText.split(' ') : [];
          var tileWidth = parseInt($(tm).find('TileWidth').first().text(), 10);
          var tileHeight = parseInt($(tm).find('TileHeight').first().text(), 10);
          var matrixWidth = parseInt($(tm).find('MatrixWidth').first().text(), 10);
          var matrixHeight = parseInt($(tm).find('MatrixHeight').first().text(), 10);
          var resolution = scaleDenominator * 0.00028 / metersPerUnit;

          if (tlc.length === 2 && !isNaN(parseFloat(tlc[0])) && !isNaN(parseFloat(tlc[1]))) {
            var originX = parseFloat(tlc[0]);
            var originY = parseFloat(tlc[1]);
            if (!topLeftCorner) {
              topLeftCorner = [originX, originY];
            }

            var thisMinX = originX;
            var thisMaxY = originY;
            var thisMaxX = originX + matrixWidth * tileWidth * resolution;
            var thisMinY = originY - matrixHeight * tileHeight * resolution;

            minX = (minX === null) ? thisMinX : Math.min(minX, thisMinX);
            minY = (minY === null) ? thisMinY : Math.min(minY, thisMinY);
            maxX = (maxX === null) ? thisMaxX : Math.max(maxX, thisMaxX);
            maxY = (maxY === null) ? thisMaxY : Math.max(maxY, thisMaxY);
          }

          labels.push(label);
          resolutions.push(resolution);
        });

        var matrixSetId = $(selectedElement).find(nameSpace + 'Identifier').first().text();
        var matrixSetTitle = $(selectedElement).find(nameSpace + 'Title').first().text();
        var wellKnownScaleSet = $(selectedElement).find('WellKnownScaleSet').first().text();
        var firstTileMatrix = null;
        if ($(selectedElement).find('TileMatrix').length > 0) {
          var firstTm = $(selectedElement).find('TileMatrix').first();
          var tlcText = $(firstTm).find('TopLeftCorner').first().text();
          firstTileMatrix = {
            matrixWidth: parseInt($(firstTm).find('MatrixWidth').first().text(), 10),
            matrixHeight: parseInt($(firstTm).find('MatrixHeight').first().text(), 10),
            topLeftCorner: tlcText ? tlcText.split(' ').map(parseFloat) : []
          };
        }

        matrixSets[matrixSetId] = {
          id: matrixSetId,
          title: matrixSetTitle,
          wellKnownScaleSet: wellKnownScaleSet,
          code: supportedCrs,
          supportedCrs: supportedCrs,
          labels: labels,
          resolutions: resolutions,
          topLeftCorner: topLeftCorner,
          projectedBounds: (minX !== null) ? [[minX, minY], [maxX, maxY]] : null,
          firstTileMatrix: firstTileMatrix
        };
        console.log('WMTS KVP DEBUG matrixSet meta=', matrixSetId, matrixSets[matrixSetId]);
      });

      $(wmtsInfo).find(xmlPathPrefix).each(function(i, selectedElement) {
        var linkedMatrixSets = [];
        $(selectedElement).find('TileMatrixSetLink').find('TileMatrixSet').each(function(j, tm) {
          linkedMatrixSets.push($(tm).text());
        });

        mapInfos.push({
          'id': $(selectedElement).find(nameSpace + 'Identifier').first().text(),
          'title': $(selectedElement).find(nameSpace + 'Title').first().text(),
          'tileMatrixSet': chooseMatrixSet(linkedMatrixSets),
          'linkedMatrixSets': linkedMatrixSets,
          'style': (function() {
            var styleId = $(selectedElement).find('Style[isDefault="true"]').find(nameSpace + 'Identifier').first().text();
            if (!styleId) styleId = $(selectedElement).find('Style').find(nameSpace + 'Identifier').first().text();
            if (!styleId) styleId = 'default';
            return styleId;
          })(),
          'format': $(selectedElement).find('Format').text(),
          'resourceUrl': httpify($(selectedElement).find('ResourceURL').attr('template')),
          'lowerCorner': $(selectedElement).find(nameSpace + bboxName).find(nameSpace + 'LowerCorner').text().split(' ').reverse(),
          'upperCorner': $(selectedElement).find(nameSpace + bboxName).find(nameSpace + 'UpperCorner').text().split(' ').reverse()
        });
      });

      function continueBuild() {
        if (!mapInfos.length) return;

        createMapForLayer(mapInfos[0], function() {
          var ProxiedWMTSTileLayer = L.TileLayer.extend({
            getTileUrl: function(coords) {
              var zoom = this._getZoomForUrl ? this._getZoomForUrl() : coords.z;
              var matrixLabel = (this.options.tileMatrixLabels && this.options.tileMatrixLabels[zoom] !== undefined) ? this.options.tileMatrixLabels[zoom] : zoom;
              var data = {
                r: L.Browser.retina ? '@2x' : '',
                s: this._getSubdomain ? this._getSubdomain(coords) : '',
                x: coords.x,
                y: coords.y,
                z: matrixLabel,
                id: this.options.id,
                style: this.options.style,
                format: this.options.format,
                tileMatrixSet: this.options.tileMatrixSet
              };
              var url = L.Util.template(this._url, L.extend(data, this.options));
              console.log('WMTS KVP DEBUG tile data=', data);
              console.log('WMTS KVP DEBUG tile finalUrl=', url);
              return url;
            }
          });

          jQuery.each(mapInfos, function(i, mapInfo) {
            var matrixInfo = matrixSets[mapInfo.tileMatrixSet];
            var tileOptions = jQuery.extend({}, mapInfo);
            if (matrixInfo) {
              tileOptions.tileMatrixLabels = matrixInfo.labels;
              tileOptions.tileSize = 256;
              tileOptions.noWrap = true;
              tileOptions.bounds = mapLatLngBounds[mapInfo.id];
              tileOptions.maxNativeZoom = matrixInfo.labels.length - 1;
              tileOptions.maxZoom = matrixInfo.labels.length - 1;
              tileOptions.minZoom = 0;
            }

            var kvpBaseUrl = self.serviceProxyUrl || (preload_resource && preload_resource['url'] ? String(preload_resource['url']).replace(/([?&].*)?$/, '') : '');
            var kvpTemplate = kvpBaseUrl + (kvpBaseUrl.indexOf('?') >= 0 ? '' : '?') +
              'SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={id}&STYLE={style}&FORMAT={format}&TILEMATRIXSET={tileMatrixSet}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}';

            maps[mapInfo.title] = new ProxiedWMTSTileLayer(
              kvpTemplate,
              tileOptions
            );
          });

          if (mapLatLngBounds[mapInfos[0].id] && mapLatLngBounds[mapInfos[0].id][0] != '') {
            self.map.fitBounds(mapLatLngBounds[mapInfos[0].id]);
          }
          overlay = maps[mapInfos[0].title];
          self.map.addLayer(maps[mapInfos[0].title]);
          L.control.layers(maps, null).addTo(self.map);
          self.map.on({baselayerchange: layerChange});

          var container = document.getElementsByClassName('leaflet-control-layers')[0];
          container && L.DomEvent.disableClickPropagation(container);

          if (!L.Browser.mobile) {
            var outer = $('<div id="control" class="ui-opacity">');
            var inner = $('<div id="handle" class="handle">');
            var start = false;
            var startTop;
            $(outer).append(inner);
            $(outer).appendTo('body');
            var handle = document.getElementById('handle');
            document.onmousemove = function(e) {
              if (!start) return;
              handle.style.top = Math.max(-5, Math.min(195, startTop + parseInt(e.clientY, 10) - start)) + 'px';
              overlay.setOpacity(1 - (handle.offsetTop / 200));
            };
            handle.onmousedown = function(e) {
              start = parseInt(e.clientY, 10);
              startTop = handle.offsetTop - 5;
              return false;
            };
            document.onmouseup = function(e) {
              start = null;
            };
          }
        });
      }

      if (bboxName == 'BoundingBox') {
        var xmlMapCrs = $(wmtsInfo).find(xmlPathPrefix).find(nameSpace + bboxName).first().attr('crs');
        var normalizedBboxCrs = normalizeCrs(xmlMapCrs);

        function transformBoundsAndContinue() {
          var EPSGUser = proj4(normalizedBboxCrs);
          jQuery.each(mapInfos, function(i, mapInfo) {
            var lowercorner = mapInfo.lowerCorner;
            var uppercorner = mapInfo.upperCorner;
            mapLatLngBounds[mapInfo.id] = [transCoord(lowercorner[1], lowercorner[0], EPSGUser), transCoord(uppercorner[1], uppercorner[0], EPSGUser)];
          });
          continueBuild();
        }

        if (!proj4.defs(normalizedBboxCrs)) {
          var bboxEpsgNum = normalizedBboxCrs.replace(/^EPSG:/, '');
          loadEPSG(window.location.protocol + '//epsg.io/' + bboxEpsgNum + '.proj4', normalizedBboxCrs, transformBoundsAndContinue);
        } else {
          transformBoundsAndContinue();
        }
      } else {
        jQuery.each(mapInfos, function(i, mapInfo) {
          mapLatLngBounds[mapInfo.id] = [mapInfo.lowerCorner, mapInfo.upperCorner];
        });
        continueBuild();
      }
    }
  };
});
