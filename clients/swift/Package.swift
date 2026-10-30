// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PBMPClient",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [
        .library(name: "PBMPClient", targets: ["PBMPClient"]),
    ],
    targets: [
        .target(name: "PBMPClient"),
        .testTarget(name: "PBMPClientTests", dependencies: ["PBMPClient"]),
    ]
)
