#!/bin/bash
# Start IAM website
node server.js &
node api/chat-proxy.js &
wait
