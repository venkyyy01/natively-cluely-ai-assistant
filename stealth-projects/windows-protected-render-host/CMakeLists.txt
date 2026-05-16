cmake_minimum_required(VERSION 3.20)

project(stealth_protected_render_host LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_executable(stealth_protected_render_host
  src/main.cpp
)
