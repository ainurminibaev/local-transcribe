// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "lt-fluid-diarize",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.18.4")
    ],
    targets: [
        .executableTarget(
            name: "lt-fluid-diarize",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
        )
    ]
)
