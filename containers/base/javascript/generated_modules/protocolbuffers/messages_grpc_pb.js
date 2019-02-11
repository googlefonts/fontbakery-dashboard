// GENERATED CODE -- DO NOT EDIT!

'use strict';
var grpc = require('grpc');
var messages_pb = require('./messages_pb.js');
var google_protobuf_any_pb = require('google-protobuf/google/protobuf/any_pb.js');
var google_protobuf_timestamp_pb = require('google-protobuf/google/protobuf/timestamp_pb.js');
var google_protobuf_empty_pb = require('google-protobuf/google/protobuf/empty_pb.js');
var shared_pb = require('./shared_pb.js');

function serialize_fontbakery_dashboard_AuthStatus(arg) {
  if (!(arg instanceof messages_pb.AuthStatus)) {
    throw new Error('Expected argument of type fontbakery.dashboard.AuthStatus');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_AuthStatus(buffer_arg) {
  return messages_pb.AuthStatus.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_AuthorizeRequest(arg) {
  if (!(arg instanceof messages_pb.AuthorizeRequest)) {
    throw new Error('Expected argument of type fontbakery.dashboard.AuthorizeRequest');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_AuthorizeRequest(buffer_arg) {
  return messages_pb.AuthorizeRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_AuthorizedRoles(arg) {
  if (!(arg instanceof messages_pb.AuthorizedRoles)) {
    throw new Error('Expected argument of type fontbakery.dashboard.AuthorizedRoles');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_AuthorizedRoles(buffer_arg) {
  return messages_pb.AuthorizedRoles.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_AuthorizedRolesRequest(arg) {
  if (!(arg instanceof messages_pb.AuthorizedRolesRequest)) {
    throw new Error('Expected argument of type fontbakery.dashboard.AuthorizedRolesRequest');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_AuthorizedRolesRequest(buffer_arg) {
  return messages_pb.AuthorizedRolesRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_FamilyData(arg) {
  if (!(arg instanceof messages_pb.FamilyData)) {
    throw new Error('Expected argument of type fontbakery.dashboard.FamilyData');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_FamilyData(buffer_arg) {
  return messages_pb.FamilyData.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_FamilyNamesList(arg) {
  if (!(arg instanceof messages_pb.FamilyNamesList)) {
    throw new Error('Expected argument of type fontbakery.dashboard.FamilyNamesList');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_FamilyNamesList(buffer_arg) {
  return messages_pb.FamilyNamesList.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_FamilyRequest(arg) {
  if (!(arg instanceof messages_pb.FamilyRequest)) {
    throw new Error('Expected argument of type fontbakery.dashboard.FamilyRequest');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_FamilyRequest(buffer_arg) {
  return messages_pb.FamilyRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ManifestSourceId(arg) {
  if (!(arg instanceof messages_pb.ManifestSourceId)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ManifestSourceId');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ManifestSourceId(buffer_arg) {
  return messages_pb.ManifestSourceId.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_OAuthToken(arg) {
  if (!(arg instanceof messages_pb.OAuthToken)) {
    throw new Error('Expected argument of type fontbakery.dashboard.OAuthToken');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_OAuthToken(buffer_arg) {
  return messages_pb.OAuthToken.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessCommand(arg) {
  if (!(arg instanceof messages_pb.ProcessCommand)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessCommand');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessCommand(buffer_arg) {
  return messages_pb.ProcessCommand.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessCommandResult(arg) {
  if (!(arg instanceof messages_pb.ProcessCommandResult)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessCommandResult');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessCommandResult(buffer_arg) {
  return messages_pb.ProcessCommandResult.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessList(arg) {
  if (!(arg instanceof messages_pb.ProcessList)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessList');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessList(buffer_arg) {
  return messages_pb.ProcessList.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessListQuery(arg) {
  if (!(arg instanceof messages_pb.ProcessListQuery)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessListQuery');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessListQuery(buffer_arg) {
  return messages_pb.ProcessListQuery.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessQuery(arg) {
  if (!(arg instanceof messages_pb.ProcessQuery)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessQuery');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessQuery(buffer_arg) {
  return messages_pb.ProcessQuery.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ProcessState(arg) {
  if (!(arg instanceof messages_pb.ProcessState)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ProcessState');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ProcessState(buffer_arg) {
  return messages_pb.ProcessState.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_PullRequest(arg) {
  if (!(arg instanceof messages_pb.PullRequest)) {
    throw new Error('Expected argument of type fontbakery.dashboard.PullRequest');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_PullRequest(buffer_arg) {
  return messages_pb.PullRequest.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_Report(arg) {
  if (!(arg instanceof messages_pb.Report)) {
    throw new Error('Expected argument of type fontbakery.dashboard.Report');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_Report(buffer_arg) {
  return messages_pb.Report.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ReportIds(arg) {
  if (!(arg instanceof messages_pb.ReportIds)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ReportIds');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ReportIds(buffer_arg) {
  return messages_pb.ReportIds.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_ReportsQuery(arg) {
  if (!(arg instanceof messages_pb.ReportsQuery)) {
    throw new Error('Expected argument of type fontbakery.dashboard.ReportsQuery');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_ReportsQuery(buffer_arg) {
  return messages_pb.ReportsQuery.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_SessionId(arg) {
  if (!(arg instanceof messages_pb.SessionId)) {
    throw new Error('Expected argument of type fontbakery.dashboard.SessionId');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_SessionId(buffer_arg) {
  return messages_pb.SessionId.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_StorageItem(arg) {
  if (!(arg instanceof messages_pb.StorageItem)) {
    throw new Error('Expected argument of type fontbakery.dashboard.StorageItem');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_StorageItem(buffer_arg) {
  return messages_pb.StorageItem.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_StorageKey(arg) {
  if (!(arg instanceof messages_pb.StorageKey)) {
    throw new Error('Expected argument of type fontbakery.dashboard.StorageKey');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_StorageKey(buffer_arg) {
  return messages_pb.StorageKey.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_StorageStatus(arg) {
  if (!(arg instanceof messages_pb.StorageStatus)) {
    throw new Error('Expected argument of type fontbakery.dashboard.StorageStatus');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_StorageStatus(buffer_arg) {
  return messages_pb.StorageStatus.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_fontbakery_dashboard_WorkerDescription(arg) {
  if (!(arg instanceof messages_pb.WorkerDescription)) {
    throw new Error('Expected argument of type fontbakery.dashboard.WorkerDescription');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_fontbakery_dashboard_WorkerDescription(buffer_arg) {
  return messages_pb.WorkerDescription.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_google_protobuf_Any(arg) {
  if (!(arg instanceof google_protobuf_any_pb.Any)) {
    throw new Error('Expected argument of type google.protobuf.Any');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_google_protobuf_Any(buffer_arg) {
  return google_protobuf_any_pb.Any.deserializeBinary(new Uint8Array(buffer_arg));
}

function serialize_google_protobuf_Empty(arg) {
  if (!(arg instanceof google_protobuf_empty_pb.Empty)) {
    throw new Error('Expected argument of type google.protobuf.Empty');
  }
  return new Buffer(arg.serializeBinary());
}

function deserialize_google_protobuf_Empty(buffer_arg) {
  return google_protobuf_empty_pb.Empty.deserializeBinary(new Uint8Array(buffer_arg));
}


// The Storage service
//
var StorageService = exports.StorageService = {
  put: {
    path: '/fontbakery.dashboard.Storage/Put',
    requestStream: true,
    responseStream: true,
    requestType: messages_pb.StorageItem,
    responseType: messages_pb.StorageKey,
    requestSerialize: serialize_fontbakery_dashboard_StorageItem,
    requestDeserialize: deserialize_fontbakery_dashboard_StorageItem,
    responseSerialize: serialize_fontbakery_dashboard_StorageKey,
    responseDeserialize: deserialize_fontbakery_dashboard_StorageKey,
  },
  // Sends another greeting
  get: {
    path: '/fontbakery.dashboard.Storage/Get',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.StorageKey,
    responseType: google_protobuf_any_pb.Any,
    requestSerialize: serialize_fontbakery_dashboard_StorageKey,
    requestDeserialize: deserialize_fontbakery_dashboard_StorageKey,
    responseSerialize: serialize_google_protobuf_Any,
    responseDeserialize: deserialize_google_protobuf_Any,
  },
  purge: {
    path: '/fontbakery.dashboard.Storage/Purge',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.StorageKey,
    responseType: messages_pb.StorageStatus,
    requestSerialize: serialize_fontbakery_dashboard_StorageKey,
    requestDeserialize: deserialize_fontbakery_dashboard_StorageKey,
    responseSerialize: serialize_fontbakery_dashboard_StorageStatus,
    responseDeserialize: deserialize_fontbakery_dashboard_StorageStatus,
  },
};

exports.StorageClient = grpc.makeGenericClientConstructor(StorageService);
// The Manifest service
//
var ManifestService = exports.ManifestService = {
  // FIXME: this is outdated but may have some good bits!
  // check for updates and emit a notice if since the last poke families
  // were updated
  // so if there's a change, we'll download it directly and put the files
  // ordered into a Files message. The sha256 hash is what we emit as
  // a change message ManifestKey: (manifiestid/collectionid, family name, filesHash)
  // PokeResponse, is basically nothing, just a OK message ... how to do this
  // best with grpc?
  // Maybe we could directly send this to the cache?
  // If we need to re-run an entiren Collection, because Font Bakery changed,
  // we still need the latest versions of the collection on disk.
  // so, it would be nice to have some form of atomicity between asking the
  // informing the ManifestMaster and running the tests. Therefore, we could
  // just put the entire current state into the cache and then let the
  // ManifestMaster decide which ones to keep and which ones to drop.
  // The Manifest itselt can in the meantime update itself etc.
  // I.e. We create a "Snapshot" of the manifest in the cache, then
  // we can forget about it
  poke: {
    path: '/fontbakery.dashboard.Manifest/Poke',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.ManifestSourceId,
    responseType: google_protobuf_empty_pb.Empty,
    requestSerialize: serialize_fontbakery_dashboard_ManifestSourceId,
    requestDeserialize: deserialize_fontbakery_dashboard_ManifestSourceId,
    responseSerialize: serialize_google_protobuf_Empty,
    responseDeserialize: deserialize_google_protobuf_Empty,
  },
  // This is the same data as the manifestSource would dispatch as
  // CollectionFamilyJob for Font Bakery.
  get: {
    path: '/fontbakery.dashboard.Manifest/Get',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.FamilyRequest,
    responseType: messages_pb.FamilyData,
    requestSerialize: serialize_fontbakery_dashboard_FamilyRequest,
    requestDeserialize: deserialize_fontbakery_dashboard_FamilyRequest,
    responseSerialize: serialize_fontbakery_dashboard_FamilyData,
    responseDeserialize: deserialize_fontbakery_dashboard_FamilyData,
  },
  list: {
    path: '/fontbakery.dashboard.Manifest/List',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.ManifestSourceId,
    responseType: messages_pb.FamilyNamesList,
    requestSerialize: serialize_fontbakery_dashboard_ManifestSourceId,
    requestDeserialize: deserialize_fontbakery_dashboard_ManifestSourceId,
    responseSerialize: serialize_fontbakery_dashboard_FamilyNamesList,
    responseDeserialize: deserialize_fontbakery_dashboard_FamilyNamesList,
  },
};

exports.ManifestClient = grpc.makeGenericClientConstructor(ManifestService);
// The Reports service
//
var ReportsService = exports.ReportsService = {
  // to file the report ("file" as a verb, but by convention first letter uppercased)
  file: {
    path: '/fontbakery.dashboard.Reports/File',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.Report,
    responseType: google_protobuf_empty_pb.Empty,
    requestSerialize: serialize_fontbakery_dashboard_Report,
    requestDeserialize: deserialize_fontbakery_dashboard_Report,
    responseSerialize: serialize_google_protobuf_Empty,
    responseDeserialize: deserialize_google_protobuf_Empty,
  },
  // Get a list of reports including selection/filtering etc.
  query: {
    path: '/fontbakery.dashboard.Reports/Query',
    requestStream: false,
    responseStream: true,
    requestType: messages_pb.ReportsQuery,
    responseType: messages_pb.Report,
    requestSerialize: serialize_fontbakery_dashboard_ReportsQuery,
    requestDeserialize: deserialize_fontbakery_dashboard_ReportsQuery,
    responseSerialize: serialize_fontbakery_dashboard_Report,
    responseDeserialize: deserialize_fontbakery_dashboard_Report,
  },
  get: {
    path: '/fontbakery.dashboard.Reports/Get',
    requestStream: false,
    responseStream: true,
    requestType: messages_pb.ReportIds,
    responseType: messages_pb.Report,
    requestSerialize: serialize_fontbakery_dashboard_ReportIds,
    requestDeserialize: deserialize_fontbakery_dashboard_ReportIds,
    responseSerialize: serialize_fontbakery_dashboard_Report,
    responseDeserialize: deserialize_fontbakery_dashboard_Report,
  },
};

exports.ReportsClient = grpc.makeGenericClientConstructor(ReportsService);
// Provides interfaces to read the data, get listings/filter.
// The Process Manager service ...
//
var ProcessManagerService = exports.ProcessManagerService = {
  // returns the current Process state initially and on each change of
  // the Process state a new Process
  subscribeProcess: {
    path: '/fontbakery.dashboard.ProcessManager/SubscribeProcess',
    requestStream: false,
    responseStream: true,
    requestType: messages_pb.ProcessQuery,
    responseType: messages_pb.ProcessState,
    requestSerialize: serialize_fontbakery_dashboard_ProcessQuery,
    requestDeserialize: deserialize_fontbakery_dashboard_ProcessQuery,
    responseSerialize: serialize_fontbakery_dashboard_ProcessState,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessState,
  },
  // same as SubscribeProcess but only returns the current state once
  getProcess: {
    path: '/fontbakery.dashboard.ProcessManager/GetProcess',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.ProcessQuery,
    responseType: messages_pb.ProcessState,
    requestSerialize: serialize_fontbakery_dashboard_ProcessQuery,
    requestDeserialize: deserialize_fontbakery_dashboard_ProcessQuery,
    responseSerialize: serialize_fontbakery_dashboard_ProcessState,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessState,
  },
  // issue a state change for a Process. `ticket` will be used to make
  // sure only expected commands are executed.
  execute: {
    path: '/fontbakery.dashboard.ProcessManager/Execute',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.ProcessCommand,
    responseType: messages_pb.ProcessCommandResult,
    requestSerialize: serialize_fontbakery_dashboard_ProcessCommand,
    requestDeserialize: deserialize_fontbakery_dashboard_ProcessCommand,
    responseSerialize: serialize_fontbakery_dashboard_ProcessCommandResult,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessCommandResult,
  },
  // the any will have to unpack to a specific message defined in the
  // ProcessManagerImplementation. e.g. DispatcherProcessManager will
  // expect here a DispatcherInitProcess
  // this may also be part of making it possible to create different
  // kinds of processes in the same process manager.
  // but right now we only deal with one process implementation at a time!
  initProcess: {
    path: '/fontbakery.dashboard.ProcessManager/InitProcess',
    requestStream: false,
    responseStream: false,
    requestType: google_protobuf_any_pb.Any,
    responseType: messages_pb.ProcessCommandResult,
    requestSerialize: serialize_google_protobuf_Any,
    requestDeserialize: deserialize_google_protobuf_Any,
    responseSerialize: serialize_fontbakery_dashboard_ProcessCommandResult,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessCommandResult,
  },
  getInitProcessUi: {
    path: '/fontbakery.dashboard.ProcessManager/GetInitProcessUi',
    requestStream: false,
    responseStream: false,
    requestType: google_protobuf_empty_pb.Empty,
    responseType: messages_pb.ProcessState,
    requestSerialize: serialize_google_protobuf_Empty,
    requestDeserialize: deserialize_google_protobuf_Empty,
    responseSerialize: serialize_fontbakery_dashboard_ProcessState,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessState,
  },
};

exports.ProcessManagerClient = grpc.makeGenericClientConstructor(ProcessManagerService);
// This service is added next to the ProcessManager service, it
// implements specific interfaces for the Font Bakery DispatcherProcessManager
// In this case things that can't be done without specific knowledge about
// how the specific process implementation (FamilyPRDispatcherProcess)
// is stored in the database and thus, how to query them.
// FamilyPRDispatcherProcess adds an important "family" name key to it's
// state which is used as a secondary key in the database and has no
// semantic/use in other implementations.
var DispatcherProcessManagerService = exports.DispatcherProcessManagerService = {
  // returns the ProcessList for the current query and then an updated
  // ProcessList when the list changes.
  subscribeProcessList: {
    path: '/fontbakery.dashboard.DispatcherProcessManager/SubscribeProcessList',
    requestStream: false,
    responseStream: true,
    requestType: messages_pb.ProcessListQuery,
    responseType: messages_pb.ProcessList,
    requestSerialize: serialize_fontbakery_dashboard_ProcessListQuery,
    requestDeserialize: deserialize_fontbakery_dashboard_ProcessListQuery,
    responseSerialize: serialize_fontbakery_dashboard_ProcessList,
    responseDeserialize: deserialize_fontbakery_dashboard_ProcessList,
  },
};

exports.DispatcherProcessManagerClient = grpc.makeGenericClientConstructor(DispatcherProcessManagerService);
// /////
// Authorization/GitHub OAuth stuff
// /////
//
var AuthServiceService = exports.AuthServiceService = {
  // **authentication**
  initSession: {
    path: '/fontbakery.dashboard.AuthService/InitSession',
    requestStream: false,
    responseStream: false,
    requestType: google_protobuf_empty_pb.Empty,
    responseType: messages_pb.AuthStatus,
    requestSerialize: serialize_google_protobuf_Empty,
    requestDeserialize: deserialize_google_protobuf_Empty,
    responseSerialize: serialize_fontbakery_dashboard_AuthStatus,
    responseDeserialize: deserialize_fontbakery_dashboard_AuthStatus,
  },
  logout: {
    path: '/fontbakery.dashboard.AuthService/Logout',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.SessionId,
    responseType: google_protobuf_empty_pb.Empty,
    requestSerialize: serialize_fontbakery_dashboard_SessionId,
    requestDeserialize: deserialize_fontbakery_dashboard_SessionId,
    responseSerialize: serialize_google_protobuf_Empty,
    responseDeserialize: deserialize_google_protobuf_Empty,
  },
  // named like this due to the OAuth workflow
  authorize: {
    path: '/fontbakery.dashboard.AuthService/Authorize',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.AuthorizeRequest,
    responseType: messages_pb.AuthStatus,
    requestSerialize: serialize_fontbakery_dashboard_AuthorizeRequest,
    requestDeserialize: deserialize_fontbakery_dashboard_AuthorizeRequest,
    responseSerialize: serialize_fontbakery_dashboard_AuthStatus,
    responseDeserialize: deserialize_fontbakery_dashboard_AuthStatus,
  },
  checkSession: {
    path: '/fontbakery.dashboard.AuthService/CheckSession',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.SessionId,
    responseType: messages_pb.AuthStatus,
    requestSerialize: serialize_fontbakery_dashboard_SessionId,
    requestDeserialize: deserialize_fontbakery_dashboard_SessionId,
    responseSerialize: serialize_fontbakery_dashboard_AuthStatus,
    responseDeserialize: deserialize_fontbakery_dashboard_AuthStatus,
  },
  //
  // **authorization** (could be another service)
  getRoles: {
    path: '/fontbakery.dashboard.AuthService/GetRoles',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.AuthorizedRolesRequest,
    responseType: messages_pb.AuthorizedRoles,
    requestSerialize: serialize_fontbakery_dashboard_AuthorizedRolesRequest,
    requestDeserialize: deserialize_fontbakery_dashboard_AuthorizedRolesRequest,
    responseSerialize: serialize_fontbakery_dashboard_AuthorizedRoles,
    responseDeserialize: deserialize_fontbakery_dashboard_AuthorizedRoles,
  },
  getOAuthToken: {
    path: '/fontbakery.dashboard.AuthService/GetOAuthToken',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.SessionId,
    responseType: messages_pb.OAuthToken,
    requestSerialize: serialize_fontbakery_dashboard_SessionId,
    requestDeserialize: deserialize_fontbakery_dashboard_SessionId,
    responseSerialize: serialize_fontbakery_dashboard_OAuthToken,
    responseDeserialize: deserialize_fontbakery_dashboard_OAuthToken,
  },
};

exports.AuthServiceClient = grpc.makeGenericClientConstructor(AuthServiceService);
// The Pull Request Dispatcher service
//
var PullRequestDispatcherService = exports.PullRequestDispatcherService = {
  // If answering directly THIS COULD TIME OUT!
  // instead, we answer with Empty and send the
  // DispatchReport message via another channel,
  // currently this is implement using an
  // AMQP queue which feeds into ProcessManager.Execute
  dispatch: {
    path: '/fontbakery.dashboard.PullRequestDispatcher/Dispatch',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.PullRequest,
    responseType: google_protobuf_empty_pb.Empty,
    requestSerialize: serialize_fontbakery_dashboard_PullRequest,
    requestDeserialize: deserialize_fontbakery_dashboard_PullRequest,
    responseSerialize: serialize_google_protobuf_Empty,
    responseDeserialize: deserialize_google_protobuf_Empty,
  },
};

exports.PullRequestDispatcherClient = grpc.makeGenericClientConstructor(PullRequestDispatcherService);
var InitWorkersService = exports.InitWorkersService = {
  // the message type of the answer is worker implementation dependent.
  init: {
    path: '/fontbakery.dashboard.InitWorkers/Init',
    requestStream: false,
    responseStream: false,
    requestType: messages_pb.WorkerDescription,
    responseType: google_protobuf_any_pb.Any,
    requestSerialize: serialize_fontbakery_dashboard_WorkerDescription,
    requestDeserialize: deserialize_fontbakery_dashboard_WorkerDescription,
    responseSerialize: serialize_google_protobuf_Any,
    responseDeserialize: deserialize_google_protobuf_Any,
  },
};

exports.InitWorkersClient = grpc.makeGenericClientConstructor(InitWorkersService);
