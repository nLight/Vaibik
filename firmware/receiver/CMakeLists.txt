cmake_minimum_required(VERSION 3.20.0)
find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(vibemic_receiver)
target_include_directories(app PRIVATE ../common)
target_sources(app PRIVATE src/main.c src/usb.c ../common/link.c
                           ../common/protocol.c ../common/playout.c)
