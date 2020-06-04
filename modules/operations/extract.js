import { actionExtract } from '../actions/extract';
import { behaviorOperation } from '../behavior/operation';
import { modeSelect } from '../modes/select';
import { t } from '../core/localizer';
import { presetManager } from '../presets';
import { utilArrayUniq } from '../util/array';

export function operationExtract(context, selectedIDs) {

    var _amount = selectedIDs.length === 1 ? 'single' : 'multiple';
    var _geometries = utilArrayUniq(selectedIDs.map(function(entityID) {
        return context.graph().hasEntity(entityID) && context.graph().geometry(entityID);
    }).filter(Boolean));
    var _geometryID = _geometries.length === 1 ? _geometries[0] : 'feature';

    var _extent;
    var _actions = selectedIDs.map(function(entityID) {
        var graph = context.graph();
        var entity = graph.hasEntity(entityID);
        if (!entity || !entity.hasInterestingTags()) return;

        if (entity.type === 'node' && graph.parentWays(entity).length === 0) return;

        var geometry = graph.geometry(entityID);
        if (geometry === 'area' || geometry === 'line') {
            var preset = presetManager.match(entity, graph);
            // only allow extraction from ways/multipolygons if the preset supports points
            if (preset.geometry.indexOf('point') === -1) return;
        }

        _extent = _extent ? _extent.extend(entity.extent(graph)) : entity.extent(graph);

        return actionExtract(entityID);
    }).filter(Boolean);


    var operation = function () {
        var combinedAction = function(graph) {
            _actions.forEach(function(action) {
                graph = action(graph);
            });
            return graph;
        };
        context.perform(combinedAction, operation.annotation());  // do the extract

        var extractedNodeIDs = _actions.map(function(action) {
            return action.getExtractedNodeID();
        });
        context.enter(modeSelect(context, extractedNodeIDs));
    };


    operation.available = function () {
        return _actions.length && selectedIDs.length === _actions.length;
    };


    operation.disabled = function () {

        if (selectedIDs.some(function(entityID) {
            return context.graph().geometry(entityID) === 'vertex' && context.hasHiddenConnections(entityID);
        })) {
            return 'connected_to_hidden';
        } else if (_extent && _extent.area() && _extent.percentContainedIn(context.map().extent()) < 0.8) {
            return 'too_large';
        }

        return false;
    };


    operation.tooltip = function () {
        var disableReason = operation.disabled();
        if (disableReason) {
            return t('operations.extract.' + disableReason + '.' + _amount);
        } else {
            return t('operations.extract.description.' + _geometryID + '.' + _amount);
        }
    };


    operation.annotation = function () {
        return t('operations.extract.annotation.' + _amount, { n: selectedIDs.length });
    };


    operation.id = 'extract';
    operation.keys = [t('operations.extract.key')];
    operation.title = t('operations.extract.title');
    operation.behavior = behaviorOperation(context).which(operation);


    return operation;
}
