/* global ckan, OL_HELPERS, ol, $, preload_resource */
// OpenLayers WMTS preview module

(function() {
    this.ckan.module('wmtsolpreview', function(jQuery, _) {
        return {
            initialize: function() {
                jQuery.proxyAll(this, /_on/);
                this.el.ready(this._onReady);
            },

            normalizeBaseMapConfig: function(mapConfig) {
                mapConfig = $.extend({}, mapConfig || {});
                if (mapConfig.type == 'custom') {
                    mapConfig.type = 'XYZ';
                } else if (!mapConfig.type) {
                    mapConfig.type = 'OSM';
                }
                return mapConfig;
            },

            getBaseMapConfigs: function() {
                var baseMapsConfig = this.options.basemapsConfig;

                if (!baseMapsConfig) {
                    var config = {
                        type: this.options.map_config['type']
                    };
                    var prefix = config.type + '.';
                    for (var fieldName in this.options.map_config) {
                        if (fieldName.startsWith(prefix)) {
                            config[fieldName.substring(prefix.length)] = this.options.map_config[fieldName];
                        }
                    }
                    baseMapsConfig = [config];
                }

                return baseMapsConfig.map(this.normalizeBaseMapConfig);
            },

            getLayerNames: function() {
                var sourceUrl = (preload_resource && (preload_resource.original_url || preload_resource.url)) || '';
                var hashIndex = String(sourceUrl).indexOf('#');
                if (hashIndex < 0) return undefined;

                var fragment = decodeURIComponent(String(sourceUrl).substring(hashIndex + 1) || '').trim();
                return fragment ? fragment.split(',') : undefined;
            },

            normalizeProjectionCode: function(code) {
                if (!code) return '';
                var match = String(code).match(/EPSG(?:::|:)(\d+)/i);
                return match ? 'EPSG:' + match[1] : String(code);
            },

            matrixSetProjectionCode: function(capas, matrixSetId) {
                var matrixSets = (capas.Contents && capas.Contents.TileMatrixSet) || [];
                for (var idx = 0; idx < matrixSets.length; idx++) {
                    if (matrixSets[idx].Identifier == matrixSetId) {
                        return this.normalizeProjectionCode(matrixSets[idx].SupportedCRS);
                    }
                }
                return '';
            },

            candidateLayers: function(capas, layerNames) {
                var candidates = (capas.Contents && capas.Contents.Layer) || [];
                if (!layerNames) return candidates;

                return candidates.filter(function(layer) {
                    return layerNames.indexOf(layer.Identifier) >= 0;
                });
            },

            chooseMatrixSet: function(capas, candidate, projectionCode) {
                var links = candidate.TileMatrixSetLink || [];
                projectionCode = this.normalizeProjectionCode(projectionCode);

                for (var idx = 0; idx < links.length; idx++) {
                    var matrixSetId = links[idx].TileMatrixSet;
                    if (this.matrixSetProjectionCode(capas, matrixSetId) == projectionCode) {
                        return matrixSetId;
                    }
                }

                return undefined;
            },

            supportsProjection: function(capas, candidates, projectionCode) {
                var self = this;
                if (!projectionCode || !candidates.length) return false;

                return candidates.every(function(candidate) {
                    return !!self.chooseMatrixSet(capas, candidate, projectionCode);
                });
            },

            createBaseLayers: function(configs) {
                var promises = configs.map(function(config, configIndex) {
                    return OL_HELPERS.createLayerFromConfig(config, true).then(function(layerList) {
                        layerList.forEach(function(layer) {
                            layer.set('baseLayerOrder', configIndex);
                        });
                        return layerList;
                    });
                });

                return $.when.apply($, promises).then(function() {
                    var layers = [];
                    for (var idx = 0; idx < arguments.length; idx++) {
                        layers = layers.concat(arguments[idx]);
                    }
                    return layers;
                });
            },

            filterBaseLayers: function(capas, candidates, layers) {
                var self = this;
                return layers.filter(function(layer) {
                    var source = layer.getSource && layer.getSource();
                    var projection = source && source.getProjection && source.getProjection();
                    var projectionCode = projection && projection.getCode();
                    return self.supportsProjection(capas, candidates, projectionCode);
                });
            },

            applyDimensions: function(layer, candidate) {
                if (!candidate.Dimension || candidate.Dimension.length <= 0) return;

                var urlTemplate = candidate.ResourceURL && candidate.ResourceURL.length > 0 && candidate.ResourceURL[0].template;
                var urlParams = (urlTemplate && urlTemplate.match(/\{(\w+?)\}/g)) || [];
                var dimensions = {};

                for (var idx = 0; idx < candidate.Dimension.length; idx++) {
                    var dim = candidate.Dimension[idx];
                    var id = dim.Identifier;

                    for (var paramIdx in urlParams) {
                        var paramName = urlParams[paramIdx].substring(1, urlParams[paramIdx].length - 1);
                        if (paramName.toLowerCase() == id) {
                            id = paramName;
                            break;
                        }
                    }

                    dimensions[id] = dim.Default;
                }

                layer.getSource().updateDimensions(dimensions);
            },

            createWmtsLayers: function(capas, candidates, projectionCode) {
                var self = this;
                var layers = [];

                candidates.forEach(function(candidate, idx) {
                    var params = {
                        layer: candidate.Identifier
                    };
                    var matrixSet = projectionCode && self.chooseMatrixSet(capas, candidate, projectionCode);
                    if (matrixSet) {
                        params.matrixSet = matrixSet;
                    }

                    var options = ol.source.WMTS.optionsFromCapabilities(capas, params);
                    var layer = new ol.layer.Tile({
                        title: candidate.Title,
                        visible: idx == 0 || self.layerNames != undefined,
                        source: new ol.source.WMTS(options)
                    });

                    self.applyDimensions(layer, candidate);

                    layer.getSource().set('name', candidate.Identifier);
                    layer.getSource().set('mlDescr', candidate);
                    layer.getSource().getFullExtent = function() {
                        return candidate.WGS84BoundingBox;
                    };
                    layer.set('wmtsResourceLayer', true);

                    layers.push(layer);
                });

                return layers;
            },

            replaceResourceLayers: function(projectionCode) {
                var self = this;
                var oldLayers = [];
                this.map.getLayers().forEach(function(layer) {
                    if (layer.get('wmtsResourceLayer')) oldLayers.push(layer);
                });
                oldLayers.forEach(function(layer) {
                    self.map.removeLayer(layer);
                });

                this.createWmtsLayers(this.capabilities, this.candidates, projectionCode).forEach(function(layer) {
                    self.map.addLayerWithExtent(layer);
                });
            },

            createMap: function(baseLayers) {
                var firstBaseLayer = baseLayers[0];
                var initialResourceLayers = [];
                var projection = firstBaseLayer && firstBaseLayer.getSource().getProjection();
                var layerSwitcher = new ol.control.HilatsLayerSwitcher();
                var layers = baseLayers.slice();

                if (!firstBaseLayer) {
                    initialResourceLayers = this.createWmtsLayers(this.capabilities, this.candidates);
                    projection = initialResourceLayers.length &&
                        initialResourceLayers[0].getSource().getProjection();
                }

                if (layers.length) {
                    layers.forEach(function(layer, idx) {
                        layer.setVisible(idx == 0);
                    });
                }

                this.map = new OL_HELPERS.LoggingMap({
                    target: $('.map')[0],
                    layers: layers,
                    controls: [
                        new ol.control.ZoomSlider(),
                        new ol.control.MousePosition(),
                        layerSwitcher
                    ],
                    loadingDiv: false,
                    loadingListener: function(isLoading) {
                        layerSwitcher.isLoading(isLoading);
                    },
                    view: new ol.View({
                        projection: projection || OL_HELPERS.Mercator
                    })
                });

                if (firstBaseLayer) {
                    this.map.getView().fit(
                        firstBaseLayer.getExtent() || ol.proj.transformExtent(OL_HELPERS.WORLD_BBOX, OL_HELPERS.EPSG4326, this.map.getView().getProjection()),
                        {constrainResolution: false}
                    );
                }

                var currentProjection = this.map.getView().getProjection();
                var self = this;
                this.map.on('change:view', function() {
                    var newProjection = self.map.getView().getProjection();
                    if (!currentProjection || !newProjection || currentProjection.getCode() !== newProjection.getCode()) {
                        self.replaceResourceLayers(newProjection && newProjection.getCode());
                    }
                    currentProjection = newProjection;
                });

                if (firstBaseLayer) {
                    this.replaceResourceLayers(projection && projection.getCode());
                } else {
                    initialResourceLayers.forEach(function(layer) {
                        self.map.addLayerWithExtent(layer);
                    });
                }
            },

            _onReady: function() {
                var self = this;
                this.el.empty();
                this.el.append($("<div></div>").attr("id", "map").addClass("map"));

                this.layerNames = this.getLayerNames();
                var capabilitiesUrl = this.options.proxy_service_url || this.options.proxy_url || (preload_resource && preload_resource.url);
                capabilitiesUrl = OL_HELPERS.cleanOGCUrl(capabilitiesUrl);

                OL_HELPERS.parseWMTSCapas(
                    capabilitiesUrl,
                    function(capas) {
                        self.capabilities = capas;
                        self.candidates = self.candidateLayers(capas, self.layerNames);

                        self.createBaseLayers(self.getBaseMapConfigs()).then(function(baseLayers) {
                            var compatibleBaseLayers = self.filterBaseLayers(capas, self.candidates, baseLayers);
                            if (!compatibleBaseLayers.length) {
                                console.log('No baselayer with appropriate CRS found');
                            }
                            self.createMap(compatibleBaseLayers);
                        }, function(err) {
                            console.warn(err);
                            console.log('No baselayer with appropriate CRS found');
                            self.createMap([]);
                        });
                    },
                    function(err) {
                        console.warn("Trouble getting WMTS capabilities");
                        console.warn(err);
                        self.el.html(self.i18n('error', {text: 'error', error: err}));
                    }
                );
            }
        };
    });
})();
