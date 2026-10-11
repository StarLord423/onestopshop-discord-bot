@echo off
cd /d "%~dp0"
echo stop>data\stop.request
echo Stop requested. The bot will close its database within about 15 seconds.
