#!/bin/bash
# Fresh database + fresh dev server for every test run.
# The [w] bracket keeps pgrep from matching this script's own command line.
for pid in $(pgrep -f "[w]rangler dev --port 8787"); do kill "$pid" 2>/dev/null; done
sleep 2
rm -rf .wrangler-test
npx wrangler d1 execute pantries-db --local --file=./schema.sql --persist-to=.wrangler-test >/dev/null 2>&1
npx wrangler d1 execute pantries-db --local --file=./seed.sql   --persist-to=.wrangler-test >/dev/null 2>&1
setsid nohup npx wrangler dev --port 8787 --persist-to=.wrangler-test > dev.log 2>&1 < /dev/null &
code=000
for i in $(seq 1 40); do
  code=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8787/api/bootstrap)
  [ "$code" = "200" ] && break
  sleep 1
done
echo "server ready ($code)"
