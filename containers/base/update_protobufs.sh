#! /usr/bin/env bash

mkdir -p ./javascript/generated_modules/protocolbuffers;
mkdir -p ./python/protocolbuffers;

# `grpc_tools_node_protoc` needs `npm install` grpc-tools is in dev dependencies
PATH="$(pwd)/javascript/node_modules/.bin:$PATH"

pushd .;
cd protocolbuffers;
# old, replaced by `grpc_tools_node_protoc`
# protoc --js_out=import_style=commonjs,binary:../javascript/generated_modules/protocolbuffers *.proto;
grpc_tools_node_protoc --js_out=import_style=commonjs,binary:../javascript/generated_modules/protocolbuffers/ \
                       --grpc_out=../javascript/generated_modules/protocolbuffers \
                       --plugin=protoc-gen-grpc=`which grpc_tools_node_protoc_plugin` *.proto


protoc --python_out=../python/protocolbuffers *.proto
popd
