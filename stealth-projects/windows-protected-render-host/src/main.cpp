#include <iostream>
#include <string>

int main(int argc, char** argv) {
  std::cout << "stealth_protected_render_host scaffold" << std::endl;
  std::cout << "next steps: create D3D11 device, probe protected-surface support, and bind a swap chain" << std::endl;

  if (argc > 1) {
    std::cout << "command: " << argv[1] << std::endl;
  }

  return 0;
}
