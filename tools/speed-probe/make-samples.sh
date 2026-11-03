#!/usr/bin/env bash
# Builds the speed probe's test audio: 8 s of synthetic speech over a quiet
# two-note chord, so it is stereo and has both speech and tones for the
# time-stretch listening test. Needs an ffmpeg with libflite and libopus.
# The output is committed; run this only to change the samples.
set -euo pipefail
cd "$(dirname "$0")/samples"
TEXT="This is the playback speed test for older webOS TVs. If this voice sounds clear at one and a half times, with no clicks or gaps, the method works on this television."
SRC=(-filter_complex "flite=text='${TEXT}':voice=slt,aresample=48000,pan=stereo|c0=c0|c1=c0,volume=1.6[v];sine=f=220:r=48000:d=8,volume=0.06[a];sine=f=330:r=48000:d=8,volume=0.05[b];[a][b]amerge=inputs=2[ab];[v][ab]amix=inputs=2:duration=longest:normalize=0,atrim=0:8[out]" -map "[out]")
ff() { ffmpeg -hide_banner -loglevel error -y -f lavfi -i anullsrc=r=48000:cl=stereo -t 8 "${SRC[@]}" "$@"; }
ff -c:a libopus -b:a 64k opus.ogg
ff -c:a libopus -b:a 64k -f webm opus.webm
ff -ar 44100 -c:a aac -b:a 96k -f adts aac.aac
ff -ar 44100 -c:a aac -b:a 96k aac.m4a
ff -ar 44100 -c:a aac -b:a 96k -movflags frag_keyframe+empty_moov+default_base_moof -frag_duration 2000000 aac-frag.mp4
ls -l
