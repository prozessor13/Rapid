import { utilArrayUnion, utilUnicodeCharsTruncated } from '@rapid-sdk/util';

import { osmIsInterestingTag } from './tags.js';


let _nextv = 0;

export function osmEntity(attrs) {
    // For prototypal inheritance.
    if (this instanceof osmEntity) return;

    // Create the appropriate subtype.
    if (attrs && attrs.type) {
        return osmEntity[attrs.type].apply(this, arguments);
    } else if (attrs && attrs.id) {
        return osmEntity[osmEntity.id.type(attrs.id)].apply(this, arguments);
    }

    // Initialize a generic Entity (used only in tests).
    return (new osmEntity()).initialize(arguments);
}


osmEntity.id = function(type) {
    return osmEntity.id.fromOSM(type, osmEntity.id.next[type]--);
};


osmEntity.id.next = {
    changeset: -1, node: -1, way: -1, relation: -1
};


osmEntity.id.fromOSM = function(type, id) {
    return type[0] + id;
};


osmEntity.id.toOSM = function(id) {
    return id.slice(1);
};


osmEntity.id.type = function(id) {
    return { 'c': 'changeset', 'n': 'node', 'w': 'way', 'r': 'relation' }[id[0]];
};


// A function suitable for use as the second argument to d3.selection#data().
osmEntity.key = function(entity) {
    return entity.id + 'v' + (entity.v || 0);
};


var _deprecatedTagValuesByKey;
osmEntity.deprecatedTagValuesByKey = function(dataDeprecated) {
    if (!_deprecatedTagValuesByKey) {
        _deprecatedTagValuesByKey = {};
        dataDeprecated.forEach(function(d) {
            var oldKeys = Object.keys(d.old);
            if (oldKeys.length === 1) {
                var oldKey = oldKeys[0];
                var oldValue = d.old[oldKey];
                if (oldValue !== '*') {
                    if (!_deprecatedTagValuesByKey[oldKey]) {
                        _deprecatedTagValuesByKey[oldKey] = [oldValue];
                    } else {
                        _deprecatedTagValuesByKey[oldKey].push(oldValue);
                    }
                }
            }
        });
    }
    return _deprecatedTagValuesByKey;
};


osmEntity.prototype = {

    tags: {},


    initialize: function(sources) {
        for (var i = 0; i < sources.length; ++i) {
            var source = sources[i];
            for (var prop in source) {
                if (Object.prototype.hasOwnProperty.call(source, prop)) {
                    if (source[prop] === undefined) {
                        delete this[prop];
                    } else {
                        this[prop] = source[prop];
                    }
                }
            }
        }

        if (!this.id && this.type) {
            this.id = osmEntity.id(this.type);
        }
        if (!this.hasOwnProperty('visible')) {
            this.visible = true;
        }

        return this;
    },


    copy: function(resolver, copies) {
        if (copies[this.id]) return copies[this.id];

        var copy = osmEntity(this, { id: undefined, user: undefined, version: undefined, v: undefined });
        copies[this.id] = copy;

        return copy;
    },


    osmId: function() {
        return osmEntity.id.toOSM(this.id);
    },


    isNew: function() {
        return this.osmId() < 0;
    },


    update: function(attrs) {
        return osmEntity(this, attrs).touch();
    },

    // Bump internal version in place
    touch: function() {
        this.v = _nextv++;
        return this;
    },

    mergeTags: function(tags) {
        var merged = Object.assign({}, this.tags);   // shallow copy
        var changed = false;
        for (var k in tags) {
            var t1 = merged[k];
            var t2 = tags[k];
            if (!t1) {
                changed = true;
                merged[k] = t2;
            } else if (k === 'building') {
                if (t2 === 'yes') {
                    continue;
                } else if (t1 === 'yes') {
                    changed = true;
                    merged[k] = t2;
                }
            } else if (t1 !== t2) {
                changed = true;
                merged[k] = utilUnicodeCharsTruncated(
                    utilArrayUnion(t1.split(/;\s*/), t2.split(/;\s*/)).join(';'),
                    255 // avoid exceeding character limit; see also services/osm.js -> maxCharsForTagValue()
                );
            }
        }
        return changed ? this.update({ tags: merged }) : this;
    },


    intersects: function(extent, resolver) {
        return this.extent(resolver).intersects(extent);
    },


    hasNonGeometryTags: function() {
        return Object.keys(this.tags).some(function(k) { return k !== 'area'; });
    },

    hasParentRelations: function(resolver) {
        return resolver.parentRelations(this).length > 0;
    },

    hasInterestingTags: function() {
        return Object.keys(this.tags).some(osmIsInterestingTag);
    },

    isHighwayIntersection: function() {
        return false;
    },

    isDegenerate: function() {
        return true;
    },

    // TODO - This does not belong here.
    // Entities should not be responsible for checking their tags are deprecated.
    // (It's telling that `dataDeprecated` needs to be passed in for it to even do this.)
    // `deprecatedTags` is only called by the `outdated_tags` validator, so maybe it should be moved there.
    // Or maybe into the `PresetSystem`, if this is a thing might be called from outside the validator.
    deprecatedTags: function(dataDeprecated) {
        var tags = this.tags;

        // if there are no tags, none can be deprecated
        if (Object.keys(tags).length === 0) return [];

        var results = [];
        dataDeprecated.forEach(function(d) {
            var oldKeys = Object.keys(d.old);
            if (d.replace) {
                var hasExistingValues = Object.keys(d.replace).some(function(replaceKey) {
                    if (!tags[replaceKey] || d.old[replaceKey]) return false;
                    var replaceValue = d.replace[replaceKey];
                    if (replaceValue === '*') return false;
                    if (replaceValue === tags[replaceKey]) return false;
                    return true;
                });
                // don't flag deprecated tags if the upgrade path would overwrite existing data - #7843
                if (hasExistingValues) return;
            }
            var matchesDeprecatedTags = oldKeys.every(function(oldKey) {
                if (!tags[oldKey]) return false;
                if (d.old[oldKey] === '*') return true;
                if (d.old[oldKey] === tags[oldKey]) return true;

                var vals = tags[oldKey].split(';').filter(Boolean);
                if (vals.length === 0) {
                    return false;
                } else if (vals.length > 1) {
                    return vals.indexOf(d.old[oldKey]) !== -1;
                } else {
                    if (tags[oldKey] === d.old[oldKey]) {
                        if (d.replace && d.old[oldKey] === d.replace[oldKey]) {
                            var replaceKeys = Object.keys(d.replace);
                            return !replaceKeys.every(function(replaceKey) {
                                return tags[replaceKey] === d.replace[replaceKey];
                            });
                        } else {
                            return true;
                        }
                    }
                }
                return false;
            });
            if (matchesDeprecatedTags) {
                results.push(d);
            }
        });

        return results;
    }
};
