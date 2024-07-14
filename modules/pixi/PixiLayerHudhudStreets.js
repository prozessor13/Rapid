import { AbstractLayer } from './AbstractLayer.js';
import { PixiFeaturePoint } from './PixiFeaturePoint.js';

const MINZOOM = 12;

const MARKERSTYLE = {
  markerName: 'mediumCircle',
  markerTint: 0xfffc4,
  viewfieldName: 'viewfield',
  viewfieldTint: 0xfffc4
};


/**
 * PixiLayerHudhudStreets
 * @class
 */
export class PixiLayerHudhudStreets extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerID  Unique string to use for the name of this Layer
   */
  constructor(scene, layerID) {
    super(scene, layerID);

    this._handleBearingChange = this._handleBearingChange.bind(this);
    this._viewerYawAngle = 0;

    if (this.supported) {
      const service = this.context.services.hudhud_streets;
      service.on('viewerChanged', this._handleBearingChange);
    }
  }



  /**
   * _handleBearingCHange
   * Handle the user dragging inside of a panoramic photo.
   */
  _handleBearingChange() {
    const service = this.context.services.hudhud_streets;

    this._viewerYawAngle = service._pannellumViewer.getYaw();
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    return !!this.context.services.hudhud_streets;
  }


  /**
   * enabled
   * Whether the user has chosen to see the Layer
   * Make sure to start the service first.
   */
  get enabled() {
    return this._enabled;
  }
  set enabled(val) {
    if (!this.supported) {
      val = false;
    }

    if (val === this._enabled) return;  // no change
    this._enabled = val;

    if (val) {
      this.dirtyLayer();
      this.context.services.hudhud_streets.startAsync();
    }
  }


  /**
   * renderMarkers
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  renderMarkers(frame, viewport, zoom) {
    const service = this.context.services.hudhud_streets;

    //We want the active image, which may or may not be the selected image.
    const activeIDs = this._classHasData.get('active') ?? new Set();

    if (!service?.started) return;

    const parentContainer = this.scene.groups.get('streetview');
    const images = service.getImages();

    for (const image of images) {
      const imageID = image.id;
      const featureID = `${this.layerID}-photo-${imageID}`;
      let feature = this.features.get(featureID);

      if (!feature) {
        const style = Object.assign({}, MARKERSTYLE);
        if (Number.isFinite(+image.heading)) {
          style.viewfieldAngles = [image.heading];
        }
        style.viewfieldName = 'pano';

        feature = new PixiFeaturePoint(this, featureID);
        feature.geometry.setCoords([+image.lng, +image.lat]);
        feature.style = style;
        feature.parentContainer = parentContainer;
        feature.setData(imageID, image);
      }
      if (activeIDs.has(imageID)) {
        feature.drawing = true;
        feature.style.viewfieldAngles = [+image.heading + this._viewerYawAngle];
        feature.style.viewfieldName = 'viewfield';
      } else  {
        feature.drawing = false;
        feature.style.viewfieldName = 'pano';
      }
      this.syncFeatureClasses(feature);
      feature.update(viewport, zoom);
      this.retainFeature(feature, frame);
    }
  }


  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame      Integer frame being rendered
   * @param  viewport   Pixi viewport to use for rendering
   * @param  zoom       Effective zoom to use for rendering
   */
  render(frame, viewport, zoom) {
    const service = this.context.services.hudhud_streets;
    if (!this.enabled || !service?.started || zoom < MINZOOM) return;

    service.loadTiles();
    this.renderMarkers(frame, viewport, zoom);
  }

}

