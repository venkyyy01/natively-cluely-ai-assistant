// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "StealthVirtualDisplayHelper",
    platforms: [
        .macOS("12.4")
    ],
    products: [
        .executable(name: "stealth-virtual-display-helper", targets: ["StealthVirtualDisplayHelper"])
    ],
    targets: [
        .executableTarget(
            name: "StealthVirtualDisplayHelper",
            path: "Sources"
        ),
        .testTarget(
            name: "StealthVirtualDisplayHelperTests",
            dependencies: ["StealthVirtualDisplayHelper"],
            path: "Tests"
        )
    ]
)
