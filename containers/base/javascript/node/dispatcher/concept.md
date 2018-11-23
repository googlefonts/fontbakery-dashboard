# Planing here: PR-dispatcher for font families.

Spent extra time to plan it as minimalistic and efficient as possible!

The plan is to implement this as a state machine
Steps: A step is made of one or more tasks.
       All tasks must have a status of OK for the process can go to the next step.
       If that is not the case the process fails and can't proceed to the next step.
             -> there will be an explicit in between task to "finalize" a step
             -> a finalized step either passes or not
             -> when the step is finalized it *can't* be opened again, it's
                frozen. Before finalizing, especially tasks that are decided
                by humans can be re-run. Possibly all tasks, it makes sense
                in all cases where the computation is not idempotent, which
                is all cases right now.
             -> after finalizing, if the step is not OK, the process is FAILED

The proceed method is thus intrinsic for the process control. It's not
quite clear if it should run automatically OR must be controlled by a human.
In general, I tend to make an all-passing step proceed automatically, while
a failing step will have to be finished (finishes the task as failing) by a human.
That way, a human may prevent the failing state and it is given that a process
closing is governed by a human, so it doesn't close unnoticed.
That includes further steps, such as:
         * filing an issue at upstream, google/fonts or even googlefonts/fontbakery-dashboard.
           Ideally each failed process creates an issue somewhere! (reality will
           not agree, but it's good to have ideals. If there's no other place to
           file the bug, maybe `googlefonts/fontbakery-dashboard` is the place :-D
A simple hack to make the auto-proceed go away would be a minimalistic task
That requires human interaction. Just an ack: OK|FAIL would do. Maybe with
a reasoning filed for a textual explanation.

Each interaction with a task will have the authors github account attached
to it.  Ideally, since we can change the results of tasks, there will
be a history for each process. So, maybe in the DB, we'll have a list
of status changes. On initialization of a task, status is always PENDING.
So, tat should be the first status entry. Unless, init FAILED.
`init` may also just OK directly, if the task is sync an can be decided
directly.
To redo a task we init it again, that's it. History is kept.
Need a history inspection thingy. Each history item can just be rendered
like the normal status. Should be not much more demanding than rendering
just one thing.

There's a lot of detailed work to implement the tasks, but everything
else should be automated and standard. So that a task can be implemented
focusing on its, well, task.

Messaging:
==========

A finished task writes a new status into its DB entry.
There are different kinds of tasks and somehow they must all report to
the DB. Ideally a process is monitoring (subscribing) to the database
and on changes decides what to do, i.e. advance the process, inform the
dev about a changed status (especially if it's a FAIL) and also inform
the dev about required manual action. Other possible notifications are
when a next step was entered (all passing statuses)
The Frontend only displays the process-document, but also needs to provide
interfaces for some tasks!
  * Interface interactions needs to be send to the tasks for evaluation.
  * I see myself dying over the interface implementation! DISLIKE! this
    must be done very much more efficiently than I used to make it before.
    - Plan possible interactions/reactions.
    - Be quick and possibly dirty


DO I need an extra long running process to monitor and control the
dispatcher OR can the webserver do this? I tend to think an extra
process is simpler, and all the web servers will talk to that.
Sounds like a good separation of concerns to me, with the added problem
that there's a lot of messaging to be done.
  * What messages need to be sent?
  * can the frontend display the process-doc without talking to that
    service? (Ideally yes, just read/monitor the DB directly)
  * The changes will come through via the db-subscription. Success/Fail
    notifications may be interesting though.


Processes/Code to be written:

- UI-Server
- UI-Client
- process manager
- task/step framework
- basic task imlementations (Manual Ack Task, …)
- special task implementations
CONINUE HERE!

The first special task is getting the package
which is nice, we also need to persist these, getting is basically done
This is an async task, but the get (the package) method returns at least
directly. The fontbakery and diffbrowsers don't necessarily work that way
we may need another active element, to send to and receive notifications
about finished tasks.
-- in case of Fontbakery:
             - either monitor the DB
             - or teach the cleanupjobs pod how/where to call back
               when a report is done.

What about versioning processes? Its clear that it will change and
there are many instances that may fail when the details are changed.
 - updated interfaces may fail rendering old tasks/steps/processes
 - steps/tasks may disappear or appear.
 - a process once started may be incompatible even before it finishes
   with a changed process. So, we may init a process, then change the
   general process structure and it would be hard to decide what to do
   with the unfinished process. Can't continue(?) because we changed the
   structure for a reason, that is, because it was insufficient before.
   So, we should maybe discover that and fail all of these processes
   automatically and maybe restart directly?
 - Maybe, we use an explicit version and when changed, we know that the
   unfinished processes are void/uncompleteable.
* do we need to check periodically (cron-like) all open tasks for something?
* on startup of process manager, it should check the versions of all
  open tasks. Because, it's most likely that the version change happened
  then, a version change will  always require a restart of the manager.
  The only function of that version is to invalidate unfinished processes
  and restart freshly.
  => We should have a general process history, that can be used to
     link the old and new processes together.
     Forward from old to new?

Tasks are firstly implemented in the process manager (via modules).
Some tasks also require ui-interaction! It would be nice to have both
in the same module, so we have it close together. The server module
and the manager will load these explicitly.
IMPORTANT: When a task changes manager AND ui-server must be updated
otherwise there are incompatible implementations possible!
Can the version thing help here too?
Or we do fancy hot-swapping... hahaha, seems like a risky stupid thing
to do with javascript, LOL!!!11!elf

Namespace: what if a task needs to persist data? Either for itself
or for another task in a later(also paralell task maybe) step?
This may be very similar to hw we are going to resolve a "pending"
status.
So, the getPackage task may write to the `package` name and the Font Bakery
task will read the `package` name. When organized into steps, we can
get along without DI. Font Bakery would just Fail when `package` is
not available and the developer is required to provide it, by putting
getPackage into a prior step.
So, do we use a file system fir this or the cache or a cache like
service (a persistant cache?) or the DB directly?
-> tendence: use a cache, but maybe extra to the one instance running
   already.
   * It's not persistant, but we can update the process manager and still
     keep the data.
   * making it persistent won't be hard, but we can get started without
     that effort.

TODO: plan more! This seems still too early to implement it the most
efficient way possible!
This stuff can also be a good start for documentation!

process manager planning
naming things! dispatcher process? Do I need to keep the dispatcher name?
Could be the Familiy Pull Request Tool

see:
https://github.com/ciaranj/connect-auth
https://github.com/doxout/node-oauth-flow
https://github.com/simov/grant

Side tasks: update FB workers to use Python 3.6
            fix the db hickup: https://github.com/googlefonts/fontbakery-dashboard/issues/78
