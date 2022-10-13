import { services } from '../services';
import { AbstractLayer } from './AbstractLayer';
import { PixiFeaturePoint } from './PixiFeaturePoint';

const LAYERID = 'notes';
const MINZOOM = 12;


/**
 * PixiLayerOsmNotes
 * @class
 */
export class PixiLayerOsmNotes extends AbstractLayer {

  /**
   * @constructor
   * @param  scene    The Scene that owns this Layer
   * @param  layerZ   z-index to assign to this Layer's container
   */
  constructor(scene, layerZ) {
    super(scene, LAYERID, layerZ);

    this._service = null;
    this.getService();

// might use these
//    const markerHighlight = new PIXI.Graphics()
//      .lineStyle(4, 0xcccccc, 0.6)
//      .moveTo(-1, -1)
//      .lineTo(-1, 17.25)
//      .lineTo(18.5, 17.25)
//      .lineTo(18.5, -1)
//      .closePath();
//
//    const ellipse = new PIXI.Graphics()
//      .lineStyle(1, 0x222222, 0.6)
//      .beginFill(0x222222, 0.6)
//      .drawEllipse(0.5, 1, 6.5, 3)
//      .endFill();
  }


  /**
   * Services are loosely coupled in RapiD, so we use a `getService` function
   * to gain access to them, and bind any event handlers a single time.
   */
  getService() {
    if (services.osm && !this._service) {
      this._service = services.osm;
      this._service.on('loadedNotes', () => this.context.map().deferredRedraw());
    } else if (!services.osm && this._service) {
      this._service = null;
    }

    return this._service;
  }


  /**
   * renderMarkers
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  renderMarkers(frame, projection, zoom) {
    const scene = this.scene;

    const service = this.getService();
    if (!service) return;

    const visibleData = service.notes(this.context.projection);

    visibleData.forEach(d => {
      const featureID = `${LAYERID}-${d.id}`;
      let feature = scene.getFeature(featureID);

      if (!feature) {
        let color = 0xff3300;  // open (red)
        // let iconName = '#iD-icon-close'
        if (d.status === 'closed') {
          color = 0x55dd00;  // closed (green)
          // iconName = '#iD-icon-apply'
        }
        if (d.isNew()) {
          color = 0xffee00;  // new (yellow)
          // iconName = '#iD-icon-plus'
        }

        const style = {
          markerName: 'osmnote',
          markerTint: color
          // iconName: iconName
        };

        feature = new PixiFeaturePoint(this, featureID);
        feature.data = d;
        feature.geometry = d.loc;
        feature.style = style;
        feature.parent = this.container;
        scene.addFeature(feature);
      }

      scene.syncFeatureState(feature);
      feature.update(projection, zoom);
      scene.retainFeature(feature, frame);
    });
  }


  /**
   * render
   * Render any data we have, and schedule fetching more of it to cover the view
   * @param  frame        Integer frame being rendered
   * @param  projection   Pixi projection to use for rendering
   * @param  zoom         Effective zoom to use for rendering
   */
  render(frame, projection, zoom) {
    const service = this.getService();

    if (this.enabled && service && zoom >= MINZOOM) {
      this.visible = true;
      service.loadNotes(this.context.projection);  // note: context.projection !== pixi projection
      this.renderMarkers(frame, projection, zoom);

    } else {
      this.visible = false;
    }
  }


  /**
   * supported
   * Whether the Layer's service exists
   */
  get supported() {
    return !!this.getService();
  }

}

