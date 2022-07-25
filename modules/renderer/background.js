import { dispatch as d3_dispatch } from 'd3-dispatch';
import { interpolateNumber as d3_interpolateNumber } from 'd3-interpolate';
import { Extent, geoMetersToOffset, geoOffsetToMeters} from '@id-sdk/math';
import { utilQsString, utilStringQs } from '@id-sdk/util';
import whichPolygon from 'which-polygon';

import { prefs } from '../core/preferences';
import { fileFetcher } from '../core/file_fetcher';
import { rendererBackgroundSource } from './background_source';
import { utilDetect } from '../util/detect';
import { utilRebind } from '../util/rebind';


let _imageryIndex = null;

export function rendererBackground(context) {
  const dispatch = d3_dispatch('change');
  const detected = utilDetect();
  let _source;
  let _checkedBlocklists = [];
  let _isValid = true;
  let _initialized = false;
  let _overlayLayers = [];
  let _brightness = 1;
  let _contrast = 1;
  let _saturation = 1;
  let _sharpness = 1;
  var _numGridSplits = 0; // No grid by default.


  function ensureImageryIndex() {
    return fileFetcher.get('imagery')
      .then(sources => {
        if (_imageryIndex) return _imageryIndex;

        _imageryIndex = {
          imagery: sources,
          features: {}
        };

        // use which-polygon to support efficient index and querying for imagery
        const features = sources.map(source => {
          if (!source.polygon) return null;
          // workaround for editor-layer-index weirdness..
          // Add an extra array nest to each element in `source.polygon`
          // so the rings are not treated as a bunch of holes:
          // what we have: [ [[outer],[hole],[hole]] ]
          // what we want: [ [[outer]],[[outer]],[[outer]] ]
          const rings = source.polygon.map(ring => [ring]);

          const feature = {
            type: 'Feature',
            properties: { id: source.id },
            geometry: { type: 'MultiPolygon', coordinates: rings }
          };

          _imageryIndex.features[source.id] = feature;
          return feature;

        }).filter(Boolean);

        _imageryIndex.query = whichPolygon({ type: 'FeatureCollection', features: features });


        // Instantiate `rendererBackgroundSource` objects for each source
        _imageryIndex.backgrounds = sources.map(source => {
          if (source.type === 'bing') {
            return rendererBackgroundSource.Bing(source, dispatch);
          } else if (/^EsriWorldImagery/.test(source.id)) {
            return rendererBackgroundSource.Esri(source);
          } else {
            return rendererBackgroundSource(source);
          }
        });

        // Add 'None'
        _imageryIndex.backgrounds.unshift(rendererBackgroundSource.None());

        // Add 'Custom'
        let template = prefs('background-custom-template') || '';
        const custom = rendererBackgroundSource.Custom(template);
        _imageryIndex.backgrounds.unshift(custom);

        return _imageryIndex;
      });
  }


  function background(selection) {
    const currSource = _source;

    // If we are displaying an Esri basemap at high zoom,
    // check its tilemap to see how high the zoom can go
    if (context.map().zoom() > 18) {
      if (currSource && /^EsriWorldImagery/.test(currSource.id)) {
        const center = context.map().center();
        currSource.fetchTilemap(center);
      }
    }

    // Is the imagery valid here? - #4827
    const sources = background.sources(context.map().extent());
    const wasValid = _isValid;
    _isValid = !!sources.filter(d => d === currSource).length;

    if (wasValid !== _isValid) {      // change in valid status
      background.updateImagery();
    }


    let baseFilter = '';
    if (detected.cssfilters) {
      if (_brightness !== 1) {
        baseFilter += ` brightness(${_brightness})`;
      }
      if (_contrast !== 1) {
        baseFilter += ` contrast(${_contrast})`;
      }
      if (_saturation !== 1) {
        baseFilter += ` saturate(${_saturation})`;
      }
      if (_sharpness < 1) {  // gaussian blur
        const blur = d3_interpolateNumber(0.5, 5)(1 - _sharpness);
        baseFilter += ` blur(${blur}px)`;
      }
    }

    let base = selection.selectAll('.layer-background')
      .data([0]);

    base = base.enter()
      .insert('div', '.layer-data')
      .attr('class', 'layer layer-background')
      .merge(base);

    if (detected.cssfilters) {
      base.style('filter', baseFilter || null);
    } else {
      base.style('opacity', _brightness);
    }

    let overlays = selection.selectAll('.layer-overlay')
      .data(_overlayLayers, d => d.name());

    overlays.exit()
      .remove();
  }


  background.numGridSplits = function(val) {
    if (!arguments.length) return _numGridSplits;
    _numGridSplits = val;
    dispatch.call('change');
    return background;
  };


  background.initDragAndDrop = function () {
    if (_initialized) return;  // run once

    function over(d3_event) {
      d3_event.stopPropagation();
      d3_event.preventDefault();
      d3_event.dataTransfer.dropEffect = 'copy';
    }

    let customDataLayer = context.scene().getLayer('custom-data');

    //Keep trying till the layers are instantiated.
    if (!customDataLayer) return;

    context.container()
      .attr('dropzone', 'copy')
      .on('drop.svgData', function (d3_event) {
        d3_event.stopPropagation();
        d3_event.preventDefault();
        if (!detected.filedrop) return;
        customDataLayer.fileList(d3_event.dataTransfer.files);
      })
      .on('dragenter.svgData', over)
      .on('dragexit.svgData', over)
      .on('dragover.svgData', over);

    _initialized = true;
  };


  background.updateImagery = function() {
    let currSource = _source;
    if (context.inIntro() || !currSource) return;

    let o = _overlayLayers
      .filter(d => !d.isLocatorOverlay() && !d.isHidden())
      .map(d => d.id)
      .join(',');

    const meters = geoOffsetToMeters(currSource.offset());
    const EPSILON = 0.01;
    const x = +meters[0].toFixed(2);
    const y = +meters[1].toFixed(2);
    let hash = utilStringQs(window.location.hash);

    let id = currSource.id;
    if (id === 'custom') {
      id = `custom:${currSource.template()}`;
    }

    if (id) {
      hash.background = id;
    } else {
      delete hash.background;
    }

    if (o) {
      hash.overlays = o;
    } else {
      delete hash.overlays;
    }

    if (Math.abs(x) > EPSILON || Math.abs(y) > EPSILON) {
      hash.offset = `${x},${y}`;
    } else {
      delete hash.offset;
    }

    if (!window.mocha) {
      window.location.replace('#' + utilQsString(hash, true));
    }

    let imageryUsed = [];
    let photoOverlaysUsed = [];

    const currUsed = currSource.imageryUsed();
    if (currUsed && _isValid) {
      imageryUsed.push(currUsed);
    }

    _overlayLayers
      .filter(d => !d.isLocatorOverlay() && !d.isHidden())
      .forEach(d => imageryUsed.push(d.imageryUsed()));

    context.history().imageryUsed(imageryUsed);
    context.history().photoOverlaysUsed(photoOverlaysUsed);
  };


  background.sources = (extent, zoom, includeCurrent) => {
    if (!_imageryIndex) return [];   // called before init()?

    let visible = {};
    (_imageryIndex.query.bbox(extent.rectangle(), true) || [])
      .forEach(d => visible[d.id] = true);

    const currSource = _source;

    // Recheck blocked sources only if we detect new blocklists pulled from the OSM API.
    const osm = context.connection();
    const blocklists = (osm && osm.imageryBlocklists()) || [];
    const blocklistChanged = (blocklists.length !== _checkedBlocklists.length) ||
      blocklists.some((regex, index) => String(regex) !== _checkedBlocklists[index]);

    if (blocklistChanged) {
      _imageryIndex.backgrounds.forEach(source => {
        source.isBlocked = blocklists.some(regex => regex.test(source.template()));
      });
      _checkedBlocklists = blocklists.map(regex => String(regex));
    }

    return _imageryIndex.backgrounds.filter(source => {
      if (includeCurrent && currSource === source) return true;  // optionally always include the current imagery
      if (source.isBlocked) return false;                        // even bundled sources may be blocked - #7905
      if (!source.polygon) return true;                          // always include imagery with worldwide coverage
      if (zoom && zoom < 6) return false;                        // optionally exclude local imagery at low zooms
      return visible[source.id];                                 // include imagery visible in given extent
    });
  };

  background.baseLayerSource = function(d) {
    if (!arguments.length) return _source;

    // test source against OSM imagery blocklists..
    const osm = context.connection();
    if (!osm) return background;

    const blocklists = osm.imageryBlocklists();
    const template = d.template();
    let fail = false;
    let tested = 0;
    let regex;

    for (let i = 0; i < blocklists.length; i++) {
      regex = blocklists[i];
      fail = regex.test(template);
      tested++;
      if (fail) break;
    }

    // ensure at least one test was run.
    if (!tested) {
      regex = /.*\.google(apis)?\..*\/(vt|kh)[\?\/].*([xyz]=.*){3}.*/;
      fail = regex.test(template);
    }

    _source = (!fail ? d : background.findSource('none'));
    dispatch.call('change');
    background.updateImagery();
    return background;
  };


  background.findSource = (id) => {
    if (!id || !_imageryIndex) return null;   // called before init()?
    return _imageryIndex.backgrounds.find(d => d.id && d.id === id);
  };


  background.bing = () => {
    background.baseLayerSource(background.findSource('Bing'));
  };


  background.showsLayer = (d) => {
    const currSource = _source;
    if (!d || !currSource) return false;
    return d.id === currSource.id || _overlayLayers.some(layer => d.id === layer.id);
  };


  background.overlayLayerSources = () => {
    return _overlayLayers;
  };


  background.toggleOverlayLayer = (d) => {
    let layer;
    for (let i = 0; i < _overlayLayers.length; i++) {
      layer = _overlayLayers[i];
      if (layer === d) {
        _overlayLayers.splice(i, 1);
        dispatch.call('change');
        background.updateImagery();
        return;
      }
    }

    layer = d;

    _overlayLayers.push(layer);
    dispatch.call('change');
    background.updateImagery();
  };


  background.nudge = (d, zoom) => {
    const currSource = _source;
    if (currSource) {
      currSource.nudge(d, zoom);
      dispatch.call('change');
      background.updateImagery();
    }
    return background;
  };


  background.offset = function(d) {
    const currSource = _source;
    if (!arguments.length) {
      return (currSource && currSource.offset()) || [0, 0];
    }
    if (currSource) {
      currSource.offset(d);
      dispatch.call('change');
      background.updateImagery();
    }
    return background;
  };


  background.brightness = function (d) {

    context.scene().getLayer('background').setBrightness(d);

    if (!arguments.length) return _brightness;
    _brightness = d;
    if (context.mode()) dispatch.call('change');
    return background;
  };


  background.contrast = function(d) {

    context.scene().getLayer('background').setContrast(d);

    if (!arguments.length) return _contrast;
    _contrast = d;
    if (context.mode()) dispatch.call('change');
    return background;
  };


  background.saturation = function(d) {
      context.scene().getLayer('background').setSaturation(d);
    if (!arguments.length) return _saturation;
    _saturation = d;
    if (context.mode()) dispatch.call('change');
    return background;
  };


  background.sharpness = function (d) {
    context.scene().getLayer('background').setSharpness(d);

    if (!arguments.length) return _sharpness;
    _sharpness = d;
    if (context.mode()) dispatch.call('change');
    return background;
  };

  let _loadPromise;

  background.ensureLoaded = () => {

    if (_loadPromise) return _loadPromise;

    function parseMapParams(qmap) {
      if (!qmap) return false;
      const params = qmap.split('/').map(Number);
      if (params.length < 3 || params.some(isNaN)) return false;
      return new Extent([params[2], params[1]]);  // lon,lat
    }

    const hash = utilStringQs(window.location.hash);
    const requested = hash.background || hash.layer;
    let extent = parseMapParams(hash.map);

    return _loadPromise = ensureImageryIndex()
      .then(imageryIndex => {
        const first = imageryIndex.backgrounds.length && imageryIndex.backgrounds[0];

        let best;
        if (!requested && extent) {
          best = background.sources(extent).find(s => s.best());
        }

        // Decide which background layer to display
        if (requested && requested.indexOf('custom:') === 0) {
          const template = requested.replace(/^custom:/, '');
          const custom = background.findSource('custom');
          background.baseLayerSource(custom.template(template));
          prefs('background-custom-template', template);
        } else {
            background.baseLayerSource(
                background.findSource(requested) ||
                best ||
                background.findSource(prefs('background-last-used')) ||
                background.findSource('Maxar-Premium') ||
                background.findSource('Bing') ||
                first ||
                background.findSource('none')
            );
        }

        const locator = imageryIndex.backgrounds.find(d => d.overlay && d.default);
        if (locator) {
          background.toggleOverlayLayer(locator);
        }

        const overlays = (hash.overlays || '').split(',');
        overlays.forEach(overlay => {
          overlay = background.findSource(overlay);
          if (overlay) {
            background.toggleOverlayLayer(overlay);
          }
        });

        if (hash.gpx) {
          const gpx = context.scene().getLayer('custom-data');
          if (gpx) {
            gpx.url(hash.gpx, '.gpx');
          }
        }

        if (hash.offset) {
          const offset = hash.offset
            .replace(/;/g, ',')
            .split(',')
            .map(n => !isNaN(n) && n);

          if (offset.length === 2) {
            background.offset(geoMetersToOffset(offset));
          }
        }
      })
      .catch(() => { /* ignore */ });
  };

    return utilRebind(background, dispatch, 'on');
  }
