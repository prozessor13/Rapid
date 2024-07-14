import { select as d3_select } from 'd3-selection';
import { timer as d3_timer } from 'd3-timer';
import { Extent, Tiler, geoMetersToLat, geoMetersToLon, geomRotatePoints, geomPointInPolygon, vecLength } from '@rapid-sdk/math';
import { utilArrayUnion, utilQsString, utilUniqueString } from '@rapid-sdk/util';
import RBush from 'rbush';

import { AbstractSystem } from '../core/AbstractSystem.js';
import { utilFetchResponse } from '../util/index.js';

const KARTAVIEW_API = 'https://kartaview.org';
const PANNELLUM_JS = 'https://cdn.jsdelivr.net/npm/pannellum@2/build/pannellum.min.js';
const PANNELLUM_CSS = 'https://cdn.jsdelivr.net/npm/pannellum@2/build/pannellum.min.css';
const TILEZOOM = 14;


/**
 * `StreetsideService`
 *
 * Events available:
 *   `imageChanged`
 *   'loadedData'
 *   'viewerChanged'
 */
export class HudhudStreetsService extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`  Global shared application context
   */
  constructor(context) {
    super(context);
    this.id = 'hudhud_streets';
    this.autoStart = false;

    this._loadPromise = null;
    this._startPromise = null;
    this._currScene = 0;
    this._cache = {};
    this._lastv = null;
    this._tiler = new Tiler().zoomRange(TILEZOOM).skipNullIsland(true);

    this._pannellumViewer = null;
    this._sceneOptions = {
      showFullscreenCtrl: true,
      showZoomCtrl: false,
      autoLoad: true,
      compass: false,
      type: 'equirectangular'
    };
  }

  /**
   * initAsync
   * Called after all core objects have been constructed.
   * @return {Promise} Promise resolved when this component has completed initialization
   */
  initAsync() {
    return this.resetAsync();
  }


  /**
   * startAsync
   * Called after all core objects have been initialized.
   * @return {Promise} Promise resolved when this component has completed startup
   */
  startAsync() {
    if (this._startPromise) return this._startPromise;

    // create hudhud-wrapper, a photo wrapper class
    const context = this.context;
    let wrap = context.container().select('.photoviewer').selectAll('.hudhud_streets-wrapper').data([0]);

    // inject hudhud-wrapper into the photoviewer div
    // (used by all to house each custom photo viewer)
    let wrapEnter = wrap.enter()
      .append('div')
      .attr('class', 'photo-wrapper hudhud_streets-wrapper')
      .classed('hide', true);

    // inject div to support streetside viewer (pannellum) and attribution line
    wrapEnter
      .append('div')
      .attr('id', 'rapideditor-viewer-hudhud_streets')
      .on('pointerdown.hudhud_streets', () => {
        d3_select(window)
          .on('pointermove.hudhud_streets', () => {
            this.emit('viewerChanged');
            this.context.systems.map.immediateRedraw();
          }, true);
      })
      .on('pointerup.hudhud_streets pointercancel.hudhud_streets', () => {
        d3_select(window)
          .on('pointermove.hudhud_streets', null);

        // continue emitting events for a few seconds, in case viewer has inertia.
        const t = d3_timer(elapsed => {
          this.emit('viewerChanged');
          if (elapsed > 2000) {
            t.stop();
          }
        });
      });

    // Register viewer resize handler
    context.systems.ui.photoviewer.on('resize.hudhud_streets', () => {
      if (this._pannellumViewer) this._pannellumViewer.resize();
    });

    return this._startPromise = this._loadAssetsAsync()
      .then(() => this._started = true)
      .catch(err => {
        if (err instanceof Error) console.error(err);   // eslint-disable-line no-console
        this._startPromise = null;
      });
  }


  /**
   * resetAsync
   * Called after completing an edit session to reset any internal state
   * @return {Promise} Promise resolved when this component has completed resetting
   */
  resetAsync() {
    if (this._cache.inflight) {
      for (const inflight of this._cache.inflight.values()) {
        inflight.controller.abort();
      }
    }

    this._cache = {
      rtree:     new RBush(),
      inflight:  new Map(),   // Map(tileID -> {Promise, AbortController})
      loaded:    new Set(),   // Set(tileID)
      images:    new Map(),   // Map(imageID -> image data)
      metadataPromise:  null
    };

    this.lastv = null;

    return Promise.resolve();
  }


  /**
   * getImages
   * Get already loaded image data that appears in the current map view
   * @return  {Array}  Array of image data
   */
  getImages() {
    const extent = this.context.viewport.visibleExtent();
    return this._cache.rtree.search(extent.bbox()).map(d => d.data);
  }


  /**
   * getSequences
   * Currently not supported
   * @return  {Array}  Array of sequence data
   */
  getSequences() {
    return [];
  }


  /**
   * loadTiles
   * Schedule any data requests needed to cover the current map view
   */
  loadTiles() {
    const viewport = this.context.viewport;
    if (this._lastv === viewport.v) return;  // exit early if the view is unchanged
    this._lastv = viewport.v;

    // Determine the tiles needed to cover the view..
    const tiles = this._tiler.getTiles(viewport).tiles;

    // Abort inflight requests that are no longer needed..
    for (const [tileID, inflight] of this._cache.inflight) {
      const needed = tiles.find(tile => tile.id === tileID);
      if (!needed) {
        inflight.controller.abort();
      }
    }

    // Issue new requests..
    for (const tile of tiles) {
      const tileID = tile.id;
      if (this._cache.loaded.has(tileID) || this._cache.inflight.has(tileID)) continue;

      this._loadTileAsync(tile);
    }
  }


  /**
   * _loadNextTilePage
   * Loads more image data
   * @param  {Tile} tile - tile object
   */
  _loadTileAsync(tile) {
    if (this._cache.loaded.has(tile.id) || this._cache.inflight.has(tile.id)) return;

    const bbox = tile.wgs84Extent.bbox();
    const controller = new AbortController();
    const options = {
      method: 'POST',
      signal: controller.signal,
      body: utilQsString({
        // bbox: [bbox.minX, bbox.minY, bbox.maxX, bbox.maxY].jsoin(",")
        ipp: 1000,
        page: 1,
        bbTopLeft: [bbox.maxY, bbox.minX].join(','),
        bbBottomRight: [bbox.minY, bbox.maxX].join(','),
      }, true),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    };
    const url = `${KARTAVIEW_API}/1.0/list/nearby-photos/`;

    fetch(url, options)
      .then(utilFetchResponse)
      .then(data => {
        this._cache.loaded.add(tile.id);
        const imageBoxes = [];
        for (let image of data.currentPageItems) {
          image.imagePath = "https://static.maptoolkit.net/examplepano.jpg"; // REMOVEME!
          image.captured_at = new Date();
          this._cache.images.set(image.id, image);
          imageBoxes.push({ minX: image.lng, minY: image.lat, maxX: image.lng, maxY: image.lat, data: image });
        }
        this._cache.rtree.load(imageBoxes);
        this.context.deferredRedraw();
        this.emit('loadedData');
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        if (err instanceof Error) console.error(err);  // eslint-disable-line no-console
      })
      .finally(() => {
        this._cache.inflight.delete(tile.id);
      });

    this._cache.inflight.set(tile.id, { promise: null, controller: controller });
  }


  get viewerShowing() {
    return this._showing;
  }


  /**
   * showViewer
   * Shows the photo viewer, and hides all other photo viewers
   */
  showViewer() {
    let wrap = this.context.container().select('.photoviewer').classed('hide', false);
    const isHidden = wrap.selectAll('.photo-wrapper.hudhud_streets-wrapper.hide').size();

    if (isHidden) {
      wrap
        .selectAll('.photo-wrapper:not(.hudhud_streets-wrapper)')
        .classed('hide', true);

      this._showing = true;

      wrap
        .selectAll('.photo-wrapper.hudhud_streets-wrapper')
        .classed('hide', false);
    }
  }


  /**
   * hideViewer
   * Hides the photo viewer and clears the currently selected image
   */
  hideViewer() {
    const context = this.context;
    context.systems.photos.selectPhoto(null);

    let viewer = context.container().select('.photoviewer');
    if (!viewer.empty()) viewer.datum(null);

    viewer
      .classed('hide', true)
      .selectAll('.photo-wrapper')
      .classed('hide', true);

    this._showing = false;

    context.container().selectAll('.viewfield-group, .sequence, .icon-sign')
      .classed('currentView', false);

    this.emit('imageChanged');
  }


  /**
   * selectImageAsync
   * Note:  most code should call `PhotoSystem.selectPhoto(layerID, photoID)` instead.
   * That will manage the state of what the user clicked on, and then call this function.
   * @param  {string} imageID - the id of the image to select
   * @return {Promise} Promise that always resolves (we should change this to resolve after the image is ready)
   */
  selectImageAsync(imageID) {
    let image = this._cache.images.get(imageID);

    if (!this._pannellumViewer) {
        this._initViewer();
    } else {
        // make a new scene
        this._currScene++;
        let sceneID = this._currScene.toString();
        console.log(Object.assign({}, this._sceneOptions, { panorama: image.imagePath }));
        this._pannellumViewer
            .addScene(sceneID, Object.assign({}, this._sceneOptions, { panorama: image.imagePath }))
            .loadScene(sceneID);

        // remove previous scene
        if (this._currScene > 2) {
            sceneID = (this._currScene - 1).toString();
            this._pannellumViewer.removeScene(sceneID);
        }
    }
  }


  /**
   * _loadAssetsAsync
   * Load the Pannellum JS and CSS files into the document head
   * @return {Promise} Promise resolved when both files have been loaded
   */
  _loadAssetsAsync() {
    if (this._loadPromise) return this._loadPromise;
    if (window.pannellum) return Promise.resolve();

    return this._loadPromise = new Promise((resolve, reject) => {
      let count = 0;
      const loaded = () => {
        if (++count === 2) resolve();
      };

      const head = d3_select('head');

      head.selectAll('#rapideditor-pannellum-css')
        .data([0])
        .enter()
        .append('link')
        .attr('id', 'rapideditor-pannellum-css')
        .attr('rel', 'stylesheet')
        .attr('crossorigin', 'anonymous')
        .attr('href', PANNELLUM_CSS)
        .on('load', loaded)
        .on('error', reject);

      head.selectAll('#rapideditor-pannellum-js')
        .data([0])
        .enter()
        .append('script')
        .attr('id', 'rapideditor-pannellum-js')
        .attr('crossorigin', 'anonymous')
        .attr('src', PANNELLUM_JS)
        .on('load', loaded)
        .on('error', reject);
    });
  }


  /**
   * _initViewer
   * Initializes the Pannellum viewer
   */
  _initViewer() {
    if (!window.pannellum) throw new Error('pannellum not loaded');
    if (this._pannellumViewer) return;  // already initted

    this._currScene++;
    const sceneID = this._currScene.toString();
    const options = {
      'default': { firstScene: sceneID },
      scenes: {}
    };
    options.scenes[sceneID] = this._sceneOptions;

    this._pannellumViewer = window.pannellum.viewer('rapideditor-viewer-hudhud_streets', options);
  }

}
