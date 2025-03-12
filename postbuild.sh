rm -rf ../node_modules

if [ -e node_modules/@prisma/engines/migration-engine-darwin-arm64 ]
then
    echo "migration darwin-arm64 exist, arm mac. delete darwin"
    rm node_modules/@prisma/engines/migration-engine-darwin
else

    echo "migration arm64 no exist, is cpu mac"
fi

rm -rf src/build.json