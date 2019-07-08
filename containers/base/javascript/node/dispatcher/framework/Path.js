"use strict";
/* jshint esnext:true, node:true*/

/** `targetPath` is a path likely the specific task
 * May also be the step (close it explicitly and forcefully)
 * and to the process
 * => {processId}/{stepId}/{taskId}
 *
 * as a string:
 * we could go for indexes OR for ids, for a mixture of both, where it
 * makes sense AND for both in all cases which is redundant.
 *
 * indexes make sense for steps, because these are an ordered list
 * ids make sense for tasks, because they are "unordered" at least
 * semantically (there's an explicit order in the `tasks` list of the
 * step that we use)
 *
 * process: {processId}
 * steps: {index}
 * task: {id} OR {index}:{id} ? => redundant, but maybe helps to reduce errors, i.e. when refactoring?
 * callback: {name}
 *
 * having an id and an index for a task, we can create a fingerprint
 * for the step. though, we can also create a fingerprint by merely
 * using ids! just have to sort the ids before to create a canonical order.
 * So, tasks don't have indexes …
 */
function Path(processId, step, task) {
    Object.defineProperties(this, {
        processId: {value: processId, enumerable: true}
      , step: {value: step, enumerable: true}
      , task: {value: task, enumerable: true}
    });
}

const _p = Path.prototype = Object.create(null);

_p.toString = function() {
    return [...this].join('/');
};

_p[Symbol.iterator] = function* () {
    if(!this.processId)
        return;
    yield this.processId;

    if(!this.step)
        return;
    yield this.step;

    if(!this.task)
        return;
    yield this.task;
};

Path.fromString = function(pathString) {
    return new Path(...pathString.split('/'));
};

exports.Path = Path;
