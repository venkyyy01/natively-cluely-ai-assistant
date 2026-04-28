// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "MacosFoundationIntentHelper",
    platforms: [
        .macOS("26.0")
    ],
    products: [
        .executable(name: "foundation-intent-helper", targets: ["MacosFoundationIntentHelper"])
    ],
    targets: [
        .executableTarget(
            name: "MacosFoundationIntentHelper",
            path: "Sources"
        )
    ]
)
