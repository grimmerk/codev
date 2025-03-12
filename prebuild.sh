mkdir -p ../node_modules/@prisma/engines
cp -r node_modules/@prisma/engines/dist ../node_modules/@prisma/engines/
cp node_modules/@prisma/engines/package.json  ../node_modules/@prisma/engines/

if [ -e node_modules/@prisma/engines/migration-engine-darwin-arm64 ]
then
    echo "migration arm64 exists. arm mac. copy darwin-arm64 as darin"
    cp node_modules/@prisma/engines/migration-engine-darwin-arm64 node_modules/@prisma/engines/migration-engine-darwin 

    # cp node_modules/@prisma/engines/introspection-engine-darwin-arm64 node_modules/@prisma/engines/introspection-engine-darwin
    # cp node_modules/@prisma/engines/libquery_engine-darwin-arm64.dylib.node node_modules/@prisma/engines/libquery_engine-darwin.dylib.node 
    # cp node_modules/@prisma/engines/prisma-fmt-darwin-arm64 node_modules/@prisma/engines/prisma-fmt-darwin 
else
    echo "migration arm64 does no exist, is cpu mac, not handle yet"
fi
