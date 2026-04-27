// wmts preview module
ckan.module('wmtspreview', function (jQuery, _) {
  return {
    initialize: function () {
      var self = this;

      self.el.empty();
      self.el.append($('<div></div>').attr('id', 'map'));
      self.map = null;

      $.ajaxSetup({
        beforeSend: function (xhr) {
          xhr.overrideMimeType('application/xml; charset=UTF-8');
        }
      });

      jQuery.get(preload_resource['url']).done(
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
      var tileVariables = {TileMatrixSet: '{tileMatrixSet}', TileMatrix: '{z}', Style: '{style}', TileRow: '{y}', TileCol: '{x}'};
      var maps = {};
      var mapLatLngBounds = {};
      var overlay;
      var matrixSets = {};

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

      //console.log('WMTS CFG DEBUG this.options=', this.options);
      //console.log('WMTS CFG DEBUG wmtsConfig=', wmtsConfig);
      //console.log('WMTS CFG DEBUG raw auto_select=', wmtsConfig.wmts_matrixset_auto_select);
      //console.log('WMTS CFG DEBUG raw preferred_keywords=', wmtsConfig.wmts_matrixset_preferred_keywords);
      //console.log('WMTS CFG DEBUG raw hide_basemap_if_incompatible=', wmtsConfig.wmts_matrixset_hide_basemap_if_incompatible);
      //console.log('WMTS CFG DEBUG raw require_xyz_grid=', wmtsConfig.wmts_matrixset_require_xyz_grid);
      //console.log('WMTS CFG DEBUG parsed auto_select=', wmtsMatrixsetAutoSelect);
      //console.log('WMTS CFG DEBUG parsed preferred_keywords=', wmtsMatrixsetPreferredKeywords);
      //console.log('WMTS CFG DEBUG parsed hide_basemap_if_incompatible=', wmtsMatrixsetHideBasemapIfIncompatible);
      //console.log('WMTS CFG DEBUG parsed require_xyz_grid=', wmtsMatrixsetRequireXyzGrid);

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
        var crs = normalizeCrs(matrixInfo.supportedCrs);
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

        //if (wellKnownScaleSet.indexOf('googlemapscompatible') >= 0) {
        //  return 1000;
        //}

        for (var i = 0; i < wmtsMatrixsetPreferredKeywords.length; i++) {
          var kw = wmtsMatrixsetPreferredKeywords[i];
          if (id.indexOf(kw) >= 0 || title.indexOf(kw) >= 0 || wellKnownScaleSet.indexOf(kw) >= 0) {
            return 900 - i;
          }
        }

        if (wmtsMatrixsetRequireXyzGrid && isStandardWebMercatorGrid(matrixInfo)) {
          return 100;
        }

        //if (!wmtsMatrixsetRequireXyzGrid && isStandardWebMercatorGrid(matrixInfo)) {
        //  return 100;
        //}

        return 0;
      }

      function chooseMatrixSet(linkedMatrixSets) {
        console.log('WMTS CFG DEBUG linkedMatrixSets=', linkedMatrixSets);
        if (!wmtsMatrixsetAutoSelect) {
          console.log('WMTS CFG DEBUG auto-select disabled, keeping first matrix set=', linkedMatrixSets.length ? linkedMatrixSets[0] : '');
          return linkedMatrixSets.length ? linkedMatrixSets[0] : '';
        }

        var bestId = linkedMatrixSets.length ? linkedMatrixSets[0] : '';
        var bestScore = -1;

        jQuery.each(linkedMatrixSets, function(i, matrixSetId) {
          var score = matrixSetCompatibilityScore(matrixSetId);
          console.log('WMTS CFG DEBUG matrixSet score=', matrixSetId, score, getMatrixInfo(matrixSetId));
          if (score > bestScore) {
            bestScore = score;
            bestId = matrixSetId;
          }
        });

        console.log('WMTS CFG DEBUG chosen matrix set=', bestId, 'score=', bestScore);
        return bestId;
      }

      function chosenMatrixSetSupportsBasemap(matrixSetId) {
        var matrixInfo = getMatrixInfo(matrixSetId);
        return isStandardWebMercatorGrid(matrixInfo);
      }

      function createMap(useBasemap) {
        if (self.map && self.map.remove) {
          self.map.remove();
        }
        $('#map').empty();

        if (useBasemap) {
          self.map = ckan.commonLeafletMap('map', self.options.map_config, {attributionControl: false, center: [0, 0], zoom: 3});
        } else {
          self.map = new L.Map('map', {attributionControl: false, center: [0, 0], zoom: 3});
        }
      }

      // Ensure that URLs have http://.
      function httpify(s) {
        if (s != undefined) {
          if (!s.match(/^[a-zA-Z]+:\/\//)) s = 'http://' + s;
	}
	return s;
      }

      // Get the layer when changing to a new layer.
      function layerChange(e) {
	overlay = e.layer;
      }

      // Load crs from epsg.io.
      function loadEPSG(url, callback) {
        var script = document.createElement('script');
        script.src = url;
        script.onreadystatechange = callback;
        script.onload = callback;
        document.getElementsByTagName('head')[0].appendChild(script);
      }

      // Transform point coordinates from user coordinate system to EPSG:4326.
      function transCoord(x, y, userCrs) {
        if (proj4) {
          var p = proj4(userCrs, EPSG4326, [parseFloat(x), parseFloat(y)]);
        }
        return [p[1], p[0]];
      }

      // Try to obtain the WGS84BoundingBox or BoundingBox.
      if ($(wmtsInfo).find(nameSpace + 'WGS84BoundingBox').length != 0) {
        bboxName = 'WGS84BoundingBox';
      } else if ($(wmtsInfo).find(nameSpace + 'BoundingBox').length != 0) {
	bboxName = 'BoundingBox';
      } else {
        bboxName = '';
      }

      // Collect available TileMatrixSet metadata.
      $(wmtsInfo).find('TileMatrixSet').filter(function() {
        return $(this).children(nameSpace + 'SupportedCRS').length > 0;
      }).each(function(i, selectedElement) {
        var matrixSetId = $(selectedElement).find(nameSpace + 'Identifier').first().text();
        var matrixSetTitle = $(selectedElement).find(nameSpace + 'Title').first().text();
        var supportedCrs = $(selectedElement).find(nameSpace + 'SupportedCRS').first().text();
        var wellKnownScaleSet = $(selectedElement).find('WellKnownScaleSet').first().text();
        var firstTileMatrix = null;

        $(selectedElement).find('TileMatrix').each(function(j, tm) {
          if (firstTileMatrix) return;
          var tlcText = $(tm).find('TopLeftCorner').first().text();
          firstTileMatrix = {
            matrixWidth: parseInt($(tm).find('MatrixWidth').first().text(), 10),
            matrixHeight: parseInt($(tm).find('MatrixHeight').first().text(), 10),
            topLeftCorner: tlcText ? tlcText.split(' ').map(parseFloat) : []
          };
        });

        matrixSets[matrixSetId] = {
          id: matrixSetId,
          title: matrixSetTitle,
          supportedCrs: supportedCrs,
          wellKnownScaleSet: wellKnownScaleSet,
          firstTileMatrix: firstTileMatrix
        };
        //console.log('WMTS CFG DEBUG matrixSet meta=', matrixSetId, matrixSets[matrixSetId]);
      });

      // Collect information for each map.
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
          'style': $(selectedElement).find('Style').find(nameSpace + 'Identifier').first().text(),
          'format': $(selectedElement).find('Format').text(),
          'resourceUrl': httpify($(selectedElement).find('ResourceURL').attr('template')),
          'lowerCorner': $(selectedElement).find(nameSpace + bboxName).find(nameSpace + 'LowerCorner').text().split(' ').reverse(),
          'upperCorner': $(selectedElement).find(nameSpace + bboxName).find(nameSpace + 'UpperCorner').text().split(' ').reverse(),
        });
      });

      // Create map with basemap depending on matrix set compatibility and configuration.
      var useBasemap = true;
      console.log('WMTS CFG DEBUG first chosen tileMatrixSet=', mapInfos[0].tileMatrixSet);
      if (wmtsMatrixsetAutoSelect && wmtsMatrixsetHideBasemapIfIncompatible) {
        useBasemap = chosenMatrixSetSupportsBasemap(mapInfos[0].tileMatrixSet);
      }
      console.log('WMTS CFG DEBUG createMap useBasemap=', useBasemap);
      createMap(useBasemap);

      // Get tiles via RESTful if the service has resourceUrls, otherwise get them via KVP.
      jQuery.each(mapInfos, function(i, mapInfo) {
        maps[mapInfo.title] = (mapInfo.resourceUrl != undefined) ?
        // Discard any unsupported tile variables.
        L.tileLayer(mapInfo.resourceUrl.replace(/{([^}]+)}/g, function(g0, g1) { return (tileVariables[g1] != undefined) ? tileVariables[g1] : ''; }), mapInfo) :
        L.tileLayer(httpify(tileUrlPrefix) + 'SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER={id}&STYLE={style}&FORMAT={format}&TILEMATRIXSET={tileMatrixSet}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}', mapInfo);
        mapLatLngBounds[mapInfo.id] = [mapInfo.lowerCorner, mapInfo.upperCorner];
      });

      // If we only have BoundingBox info, load crs from epsg.io.
      if (bboxName == 'BoundingBox') {
        xmlMapCrs = $(wmtsInfo).find(xmlPathPrefix).find(nameSpace + bboxName).first().attr("crs");
        EPSG = xmlMapCrs.substring(xmlMapCrs.indexOf("EPSG::") + 6, xmlMapCrs.length);
        loadEPSG('http://epsg.io/' + EPSG + '.js', function() {
	  // Except for EPSG:3821 (which is incomplete)
          if (EPSG == 3821) {
            proj4.defs([
              ['EPSG:3821', '+proj=tmerc +ellps=GRS67 +towgs84=-752,-358,-179,-.0000011698,.0000018398,.0000009822,.00002329 +lat_0=0 +lon_0=121 +x_0=250000 +y_0=0 +k=0.9999 +units=m +no_defs']
            ]);
          }
          EPSGUser = proj4('EPSG:' + EPSG);
          jQuery.each(mapInfos, function(i, mapInfo) {
            lowercorner = mapLatLngBounds[mapInfo.id][0];
            uppercorner = mapLatLngBounds[mapInfo.id][1];
            mapLatLngBounds[mapInfo.id] = [transCoord(lowercorner[1], lowercorner[0], EPSGUser), transCoord(uppercorner[1], uppercorner[0], EPSGUser)];
          });
          self.map.fitBounds(mapLatLngBounds[mapInfos[0].id]);
        });
      }

      overlay = maps[mapInfos[0].title];
      self.map.addLayer(maps[mapInfos[0].title]);
      L.control.layers(maps, null).addTo(self.map);
      if (mapLatLngBounds[mapInfos[0].id][0] != '') self.map.fitBounds(mapLatLngBounds[mapInfos[0].id]);
      self.map.on({baselayerchange: layerChange});

      // Layer control for mobile
      var container = document.getElementsByClassName('leaflet-control-layers')[0];
      L.DomEvent.disableClickPropagation(container);

      // Opacity control for desktop
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
    }
  };
});
