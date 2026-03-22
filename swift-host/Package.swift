// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "NativelyHost",
    platforms: [
        .macOS(.v12)
    ],
    products: [
        .executable(name: "assistantservicesd", targets: ["NativelyHost"])
    ],
    dependencies: [],
    targets: [
        .executableTarget(
            name: "NativelyHost",
            dependencies: [],
            path: "NativelyHost",
            exclude: ["Resources/Info.plist"],
            resources: [
                .copy("Resources/models")
            ]
        ),
        .testTarget(
            name: "NativelyHostTests",
            dependencies: ["NativelyHost"],
            path: "NativelyHostTests"
        )
    ]
)
