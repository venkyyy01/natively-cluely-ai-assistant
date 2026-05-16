// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MacosFullStealthHelper",
    platforms: [
        .macOS("12.4")
    ],
    products: [
        .executable(name: "macos-full-stealth-helper", targets: ["MacosFullStealthHelper"])
    ],
    targets: [
        .executableTarget(
            name: "MacosFullStealthHelper",
            path: "Sources"
        )
    ]
)
