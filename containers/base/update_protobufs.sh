#! /usr/bin/env bash

mkdir -p ./javascript/generated_modules/protocolbuffers
mkdir -p ./python/protocolbuffers

pushd .
cd protocolbuffers
protoc --js_out=import_style=commonjs,binary:../javascript/generated_modules/protocolbuffers *.proto
protoc --python_out=../python/protocolbuffers *.proto
popd
