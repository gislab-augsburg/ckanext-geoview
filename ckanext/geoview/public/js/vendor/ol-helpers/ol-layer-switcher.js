/* global ol, $ */
/**
 * Adapted from https://github.com/walkermatt/ol3-layerswitcher
 */
class HilatsLayerSwitcher extends ol.control.Control {
    constructor (opt_options) {
        var options = opt_options || {};

        var parentElement = $("<div class='layer-switcher'></div>")

        super({
            element: parentElement[0],
            target: options.target
        });

        this.baseLayerLabel = options.baseLayerLabel || 'Base Map';
        this.layersLabel = options.layersLabel || 'Layers';

        var _this = this;
        this.mapListeners = [];
        this.parentElement = parentElement.hover(
            function(e) {
                _this.showPanel();
            },
            function(e) {
                // deal with FF triggering a mouseout when opening the select dropdown
                // cf https://stackoverflow.com/questions/32561180/keep-hover-triggered-twitter-bootstrap-popover-alive-while-selecting-option-from
                if (!(e.target && e.target.tagName == 'SELECT'))
                    _this.hidePanel();
            }
        );


        var layerList = $("<div class='ol-unselectable ol-control layer-list'></div>");
        this.layerList = layerList[0];
        this.header = $("<div class='switcher-section base-map-section'></div>").appendTo(layerList)[0];
        this.layersTitle = $("<div class='switcher-section-title layers-title'></div>").appendTo(layerList)[0];

        var progressIndicator =  $("<div class='stacked-layers'>" +
                                   "<div class='stacked-layer layer-1'></div>" +
                                   "<div class='stacked-layer layer-2'></div>" +
                                   "<div class='stacked-layer layer-3'></div></div>");
        this.parentElement
            .append(progressIndicator)
            .append(layerList);

        this.panel = $("<div class='panel'></div>").appendTo(layerList)[0];
        this.enableTouchScroll_(this.panel);
    };

    /**
     * Show the layer panel.
     */
    showPanel() {
        if (! $(this.panel).is(":visible")) {
            this.parentElement.addClass('active');
            this.renderPanel();
        }
    };

    isLoading(toggle) {
        $(this.element).find('.stacked-layer').toggleClass('animated', toggle)
    };

    /**
     * Hide the layer panel.
     */
    hidePanel() {
        this.parentElement.removeClass('active');
    };

    /**
     * Re-draw the layer panel to represent the current state of the layers.
     */
    renderPanel() {

        this.ensureTopVisibleBaseLayerShown_();

        $(this.header).empty()
            .append($("<div class='switcher-section-title'></div>").text(this.baseLayerLabel))
            .append(this.renderBaseLayerSelector());
        $(this.layersTitle).text(this.layersLabel);

        this.renderLayersList(this.getMap().getLayers().getArray().slice().reverse())
            .appendTo($(this.panel).empty())

        this.syncBaseLayerSelector_();
        this.resizeLayerList_();

    };

    setMap(map) {
        super.setMap(map);
        if (map) {
            this.renderPanel();
        }
    };

    renderBaseLayerSelector() {
        var _this = this;
        var $select = $("<select></select>")
            .change(function(e) {
                var layer = $(e.target).find(":selected").prop("layer");
                _this.switchBaseLayer(layer)
            })
        return $("<div class='baseLayerSelector'></div>")
            .append($select);
    };

    renderBaseLayer(baselayer) {
        var $select = $(this.header).find(".baseLayerSelector select");

        // use title to identify basemaps; ol_uid is not available in non-debug OL
        $select.append(
            $('<option/>', {value: baselayer.get('title')})
                .prop("layer", baselayer)
                .text(baselayer.get('title'))
        )

        $select.append($select.find("option").sort(function(a, b) {
            var aLayer = $(a).prop("layer");
            var bLayer = $(b).prop("layer");
            var aOrder = aLayer && aLayer.get('baseLayerOrder');
            var bOrder = bLayer && bLayer.get('baseLayerOrder');

            if (aOrder === undefined && bOrder === undefined) return 0;
            if (aOrder === undefined) return 1;
            if (bOrder === undefined) return -1;
            return aOrder - bOrder;
        }));

    };

    switchBaseLayer(baselayer) {
        // hide all base layers
        forEachRecursive(this.getMap(), function(l, idx, a) {
            if (l.get('type') === 'base') {
                l.setVisible(false);
            }
        });

        //switch projection
        var newProjection = baselayer.getSource() && baselayer.getSource().getProjection();
        var currentView = this.getMap().getView();
        var currentProjection = currentView && currentView.getProjection();
        if (newProjection && currentProjection && newProjection.getCode() !== currentProjection.getCode()) {
            var currentExtent = currentView.calculateExtent();
            var newExtent = ol.proj.transformExtent(currentExtent, currentProjection, newProjection);
            var newView = new ol.View({
                projection: newProjection
            })
            this.getMap().setView(newView);

            // doing setView messes with the extent
            // --> set extent after
            newView.fit(newExtent, {constrainResolution: false});
        }


        // display base layer
        this.setVisible_(baselayer, true);
        this.syncBaseLayerSelector_();

    };

    /**
     * Ensure only the top-most base layer is visible if more than one is visible.
     * @private
     */
    ensureTopVisibleBaseLayerShown_() {
        var visibleBaseLyr = this.getVisibleBaseLayer_();
        if (visibleBaseLyr) this.setVisible_(visibleBaseLyr, true);
    };

    /**
     * Return the configured order for a base layer.
     * @private
     */
    getBaseLayerOrder_(lyr) {
        var order = lyr && lyr.get('baseLayerOrder');
        return order === undefined ? 999999 : order;
    };

    /**
     * Return the visible base layer that should be represented in the selector.
     * @private
     */
    getVisibleBaseLayer_() {
        var _this = this;
        var visibleBaseLyr;
        var visibleBaseOrder;
        forEachRecursive(this.getMap(), function(l, idx, a) {
            if (l.get('type') === 'base' && l.getVisible()) {
                var order = _this.getBaseLayerOrder_(l);
                if (!visibleBaseLyr || order < visibleBaseOrder) {
                    visibleBaseLyr = l;
                    visibleBaseOrder = order;
                }
            }
        });
        return visibleBaseLyr;
    };

    /**
     * Keep the base layer selector in sync after rendering or switching layers.
     * @private
     */
    syncBaseLayerSelector_() {
        var visibleBaseLyr = this.getVisibleBaseLayer_();
        if (visibleBaseLyr) {
            $(this.header).find(".baseLayerSelector select").val(visibleBaseLyr.get('title'));
        }
    };

    /**
     * Keep long layer lists inside the current map viewport.
     * @private
     */
    resizeLayerList_() {
        var map = this.getMap();
        var mapElement = map && map.getTargetElement && map.getTargetElement();
        var mapHeight = mapElement ? $(mapElement).height() : $(this.element).closest('.ol-viewport').height();
        var listTop = parseInt($(this.layerList).css('top'), 10) || 5;
        var listBottom = parseInt($(this.layerList).css('bottom'), 10) || 5;
        var fixedHeight = $(this.header).outerHeight(true) + $(this.layersTitle).outerHeight(true);
        var maxListHeight = mapHeight ? Math.max(80, mapHeight - listTop - listBottom) : 300;
        var maxPanelHeight = Math.max(60, maxListHeight - fixedHeight);

        $(this.layerList).css({
            'max-height': maxListHeight + 'px',
            'overflow': 'hidden'
        });
        $(this.panel).css({
            'max-height': maxPanelHeight + 'px',
            'overflow-x': 'hidden',
            'overflow-y': 'auto'
        });
    };

    /**
     * Toggle the visible state of a layer.
     * Takes care of hiding other layers in the same exclusive group if the layer
     * is toggle to visible.
     * @private
     * @param {ol.layer.Base} The layer whos visibility will be toggled.
     */
    setVisible_(lyr, visible) {
        var map = this.getMap();
        lyr.setVisible(visible);
        if (visible && lyr.get('type') === 'base') {
            // Hide all other base layers regardless of grouping
            forEachRecursive(map, function(l, idx, a) {
                if (l != lyr && l.get('type') === 'base') {
                    l.setVisible(false);
                }
            });
        }
    };

    renderLayer(lyr, container) {

        if (lyr.get('type') === 'base') {
            this.renderBaseLayer(lyr)
            return;
        }

        var this_ = this;

        var li = $("<li></li>")

        var label = $("<span class='title'></span>").text(lyr.get('title'))
        if (lyr.getLayers) {

            li.append(label.addClass('group'));
            var layerList = this.renderLayersList(lyr.getLayers().getArray().slice().reverse())
            li.append(layerList);

        } else {

            li.addClass('layer');
            var input = $("<input>")
                .prop("checked", lyr.get('visible'))
                .attr("type", 'checkbox')
                .change(function(e) {this_.setVisible_(lyr, e.target.checked)})
                .appendTo(li);
            li.append(label);

            var stateListener = function() {
                if (lyr.getSource().getState() == ol.source.State.LOADING ||
                    lyr.getSource().get('HL_state') == ol.source.State.LOADING) {
                    li.append("<div class='state simple_loader' style='display: inline-block; float:right'></div>")
                } else if (lyr.getSource().getState() == ol.source.State.ERROR) {
                    li.append("<i class='state fa fa-error' />")
                } else {
                    li.find(".state").remove();
                }
            };

            stateListener();

            lyr.getSource().on('change:HL_state', stateListener);
        }

        if (container)
            li.appendTo(container)

        return li;

    };

    /**
     * Render all layers that are children of a group.
     * @private
     * @param {ol.layer.Group} lyr Group layer whos children will be rendered.
     * @param {Element} elm DOM element that children will be appended to.
     */
    renderLayersList(layers) {
        var _this = this;
        var $list = $("<ul></ul>")
        layers.forEach(function(l) {
            if (l.get('title')) {
                _this.renderLayer(l, $list);
            }
        });
        return $list;
    };


    /**
     * @private
     * @desc Apply workaround to enable scrolling of overflowing content within an
     * element. Adapted from https://gist.github.com/chrismbarr/4107472
     */
    enableTouchScroll_(elm) {
        if(this.isTouchDevice_()){
            var scrollStartPos = 0;
            elm.addEventListener("touchstart", function(event) {
                scrollStartPos = this.scrollTop + event.touches[0].pageY;
            }, false);
            elm.addEventListener("touchmove", function(event) {
                this.scrollTop = scrollStartPos - event.touches[0].pageY;
            }, false);
        }
    };

    /**
     * @private
     * @desc Determine if the current browser supports touch events. Adapted from
     * https://gist.github.com/chrismbarr/4107472
     */
    isTouchDevice_(){
        try {
            document.createEvent("TouchEvent");
            return true;
        } catch(e) {
            return false;
        }
    };

}
ol.control.HilatsLayerSwitcher = HilatsLayerSwitcher;


/**
 * **Static** Call the supplied function for each layer in the passed layer group
 * recursing nested groups.
 * @param {ol.layer.Group} lyr The layer group to start iterating from.
 * @param {Function} fn Callback which will be called for each `ol.layer.Base`
 * found under `lyr`. The signature for `fn` is the same as `ol.Collection#forEach`
 */
const forEachRecursive = function(lyr, fn) {
    lyr.getLayers().forEach(function(lyr, idx, a) {
        fn(lyr, idx, a);
        if (lyr.getLayers) {
            forEachRecursive(lyr, fn);
        }
    });
};
