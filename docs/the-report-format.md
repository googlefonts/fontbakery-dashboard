# The Report Format

The report format will be described as JSON here. Though it is currently
a rethinkDB document. Some of the rationale and intended usage is
documented here.


## Top Level Keys

### `<Report>`

```
{
// always there
    "created": <Date> // document creation time
  , "id": <String> // the unique document id in the database(-table?)
// after processing has started
  , "started": <Date> // processing start time
  , "preparation_logs": <Array> // lines of logs of the dispatcher preparation
  , "execution_order" <Array> //  <Test-Identity>-Keys in fontbakeries order
  , "iterargs": <Dict> //  keys the names of the iterargs; values: <Array>
  , "jobs": <Array> // jobs metadata <Dict>s... TODO: explain why and rationale
  , "tests": <Dict> // keys: <Test-Identity>; values: test result <Dict>s
// in case of an exception
  , "finished": <Date> // job end time
  , "exception": <String> // exception and traceback
}

There's no `finished` for regular execution. When all jobs have a `finished`
date (all tests must have registered their statuses), `finished` equals
the highest `finished` of all jobs.

```

### `<Report.jobs>`

Not sure why tracking jobs this way. Though, we can see when a job fails
finally or when it never ran. For future jobs that answer with high latency
(because humans need to work them) This could be the perfect place to look
where/how to start them. Such a job can itself yield multiple tests, which
seems like a good, further way of structuring, if needed. The job must somehow
register its tests in the spec. The dispatcher has to know how to group these
jobs. May be a big effort, but would integrate well.

```
{
// always there
    "created": <Date> // job creation time; is ~ document creation time
  , "id": <integer> // unique id and index in jobs <Array>
// after processing has started
  , "started": <Date> // processing start time
// after the job ended (also if ended exceptionally)
  , "finished": <Date> // job end time
// in case of an exception
  , "exception": <String> // exception and traceback
```

###  `<Report.tests>`

Do we need more info here? started, ended, microtime ended-started?
When finished: aggregeate results? (we could get that probably with a
good reql query). Also, if we plan to do overrides, we'll have a lot
of intepretation going on anyways.
Not sure if we should break the SSOT here. Maybe we'll do when there's a
good reason to do so (speed, code is not DRY enough).

We could put the order index in here! Why not? We'd need to count tests that
have a status to see if everything is finished.

```
{
    "job_id": 0
  , "statuses": [
        {
            "message": "/tmp/tmpV4Hfn9/RobotoSlab-Bold.ttf is named canonically." ,
            "status": "PASS"
        }
    ]
}
```



tests as an array vs. an dict:

pro array:
- Append is probably faster than the rethinkdb `merge` equivalent for a dict
- With append we have a way to see when a job runs multiple times* (for whatever reason).
  It may be better to factor in possible failure! A list with append could
  be interpreted in any way.

pro dict:
- When the number of keys equals the length of "execution_order" the test is
  finished. With append, failing jobs could make the list longer than the
  "execution_order" and we could still miss some tests. RethinkDB has an easy
  "count" function to count the number of key/value pairs in an object!
- we already have execution_order to store the order, reading tests by key seems
  natural. order of being logged is not essential.





* A job runs multiple times:

We now have good error handling, so the job wouldn't crash. But the default
behavior of AMPQ is to re-queue a message when the receiver dies and Kubernetes
restarts a pod that has died. The rationale is, that such an error may be
caused by missing external resources (e.g. Database) and these may become
available later. Thus, If our job runs half way through, then dies fatally,
it may be better to have it resubmit test results instead of not finishing
the ever.







