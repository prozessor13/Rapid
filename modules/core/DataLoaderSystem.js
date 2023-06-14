import { AbstractSystem } from './AbstractSystem';

/**
 * `DataLoaderSystem` fetches data in JSON files
 */
export class DataLoaderSystem extends AbstractSystem {

  /**
   * @constructor
   * @param  `context`   Global shared application context
   */
  constructor(context) {
    super(context);

    const fileMap  = new Map();
    fileMap.set('address_formats', 'data/address_formats.min.json');
    fileMap.set('deprecated', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/deprecated.min.json');
    fileMap.set('discarded', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/discarded.min.json');
    fileMap.set('imagery', 'data/imagery.min.json');
    fileMap.set('intro_graph', 'data/intro_graph.min.json');
    fileMap.set('intro_rapid_graph', 'data/intro_rapid_graph.min.json');
    fileMap.set('keepRight', 'data/keepRight.min.json');
    fileMap.set('languages', 'data/languages.min.json');
    fileMap.set('locales', 'locales/index.min.json');
    fileMap.set('oci_defaults', 'https://cdn.jsdelivr.net/npm/osm-community-index@5.5/dist/defaults.min.json');
    fileMap.set('oci_features', 'https://cdn.jsdelivr.net/npm/osm-community-index@5.5/dist/featureCollection.min.json');
    fileMap.set('oci_resources', 'https://cdn.jsdelivr.net/npm/osm-community-index@5.5/dist/resources.min.json');
    fileMap.set('phone_formats', 'data/phone_formats.min.json');
    fileMap.set('preset_categories', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/preset_categories.min.json');
    fileMap.set('preset_defaults', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/preset_defaults.min.json');
    fileMap.set('preset_fields', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/fields.min.json');
    fileMap.set('preset_presets', 'https://cdn.jsdelivr.net/npm/@openstreetmap/id-tagging-schema@6.0/dist/presets.min.json');
    fileMap.set('qa_data', 'data/qa_data.min.json');
    fileMap.set('shortcuts', 'data/shortcuts.min.json');
    fileMap.set('territory_languages', 'data/territory_languages.min.json');
    fileMap.set('wmf_sitematrix', 'https://cdn.jsdelivr.net/npm/wmf-sitematrix@0.1/wikipedia.min.json');

    this.fileMap = fileMap;
    this._cachedData = {};
    this._inflight = {};

    // Mock data for testing, prevents the data from being fetched.
    // Not sure how I feel about this :-/
    if (window.mocha) {
      const c = this._cachedData;
      c.address_formats = [{ format: [['housenumber', 'street'], ['city', 'postcode']] }];
      c.deprecated = [{ old: { highway: 'no' } }, { old: { highway: 'ford' }, replace: { ford: '*' } } ];
      c.discarded = {};
      c.imagery = [];
      c.keepRight = {};
      c.languages = { de: { nativeName: 'Deutsch' }, en: { nativeName: 'English' } };
      c.locales = { en: { rtl: false, pct: 1 } };
      c.locale_general_en = { en: {} };
      c.locale_tagging_en = { en: {} };
      c.locales_index_general = { en: { rtl: false, pct: 1 } };
      c.locales_index_tagging = { en: { rtl: false, pct: 1 } };
      c.phone_formats = {};
      c.preset_categories = {};
      c.preset_defaults = {};
      c.preset_fields = {};
      c.preset_presets = {};
      c.qa_data = { improveOSM: {}, osmose: {} };
      c.shortcuts = [];
      c.territory_languages = {};
      c.wmf_sitematrix = [ ['English','English','en'], ['German', 'Deutsch', 'de'] ];
    }
  }


  // Returns a Promise to fetch data
  // (resolved with the data if we have it already)
  get(fileID) {
    if (this._cachedData[fileID]) {
      return Promise.resolve(this._cachedData[fileID]);
    }

    const file = this.fileMap.get(fileID);
    const url = file && this.context.asset(file);
    if (!url) {
      return Promise.reject(`Unknown data file for "${fileID}"`);
    }

    let prom = this._inflight[url];
    if (!prom) {
      this._inflight[url] = prom = fetch(url)
        .then(response => {
          // fetch in PhantomJS tests may return ok=false and status=0 even if it's okay
          if ((!response.ok && response.status !== 0) || !response.json) {
            throw new Error(response.status + ' ' + response.statusText);
          }
          if (response.status === 204 || response.status === 205) return;  // No Content, Reset Content
          return response.json();
        })
        .then(result => {
          delete this._inflight[url];
          if (!result) {
            throw new Error(`No data loaded for "${fileID}"`);
          }
          this._cachedData[fileID] = result;
          return result;
        })
        .catch(err => {
          delete this._inflight[url];
          throw err;
        });
    }

    return prom;
  }

}