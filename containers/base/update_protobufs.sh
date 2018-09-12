#! /usr/bin/env bash

mkdir -p ./javascript/generated_modules/protocolbuffers;
mkdir -p ./python/protocolbuffers;
touch ./python/protocolbuffers/__init__.py

# `grpc_tools_node_protoc` needs `npm install` grpc-tools is in dev dependencies
PATH="$(pwd)/javascript/node_modules/.bin:$PATH"


# created with:
# $ python3 -m venv devvenv
# $ source devvenv/bin/activate
# $ pip install --upgrade pip
# $ pip install -r dev-requirements.txt
source devvenv/bin/activate



pushd .;
cd protocolbuffers;

if [ -d ./gftools ]; then
    pushd .; cd gftools && git pull || exit 1; popd;
else
    git clone --depth 1 -b master http://github.com/googlefonts/gftools.git || exit 1;
fi
cp gftools/Lib/gftools/fonts_public.proto . || exit 1

echo "generating javascript protocolbuffers ..."

# old, replaced by `grpc_tools_node_protoc`
# protoc --js_out=import_style=commonjs,binary:../javascript/generated_modules/protocolbuffers *.proto;
grpc_tools_node_protoc --js_out=import_style=commonjs,binary:../javascript/generated_modules/protocolbuffers/ \
                       --grpc_out=../javascript/generated_modules/protocolbuffers \
                       --plugin=protoc-gen-grpc=`which grpc_tools_node_protoc_plugin` \
                       *.proto

ls ../javascript/generated_modules/protocolbuffers

echo "generating python protocolbuffers ..."

# protoc --python_out=../python/protocolbuffers *.proto
python -m grpc_tools.protoc -I./ \
                            --python_out=../python/protocolbuffers \
                            --grpc_python_out=../python/protocolbuffers \
                            *.proto

ls ../python/protocolbuffers

echo 'DONE!'
