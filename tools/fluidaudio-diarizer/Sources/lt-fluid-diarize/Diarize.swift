import CoreML
import FluidAudio
import Foundation

struct Segment: Encodable {
    let start: Float
    let end: Float
    let speaker: String
}

enum UsageError: Error {
    case expectedInputAndOutput
    case invalidSpeakerCount
}

@main
struct Diarize {
    static func main() async throws {
        let args = CommandLine.arguments
        let prepare = Array(args.dropFirst()) == ["--prepare-models"]
        guard prepare || args.count == 3 || args.count == 4 else {
            throw UsageError.expectedInputAndOutput
        }

        // A transcription must never download models or build dependencies.
        ModelHub.offlineMode = !prepare
        var config = OfflineDiarizerConfig(
            minSegmentDuration: 0.0,
            exclusiveSegments: false
        )
        if args.count == 4 {
            guard let count = Int(args[3]), (1...32).contains(count) else {
                throw UsageError.invalidSpeakerCount
            }
            config = config.withSpeakers(exactly: count)
        }
        let compute = MLModelConfiguration()
        compute.computeUnits = .cpuAndNeuralEngine
        let models = try await OfflineDiarizerModels.load(configuration: compute)
        guard !prepare else { return }
        let manager = OfflineDiarizerManager(config: config)
        manager.initialize(models: models)
        let audio = try AudioSourceFactory().makeDiskBackedSource(
            from: URL(fileURLWithPath: args[1]), targetSampleRate: 16_000
        )
        defer { audio.source.cleanup() }
        let result = try await manager.process(
            audioSource: audio.source, audioLoadingSeconds: audio.loadDuration
        )
        let segments = result.segments.map {
            Segment(start: $0.startTimeSeconds, end: $0.endTimeSeconds, speaker: $0.speakerId)
        }
        try JSONEncoder().encode(segments).write(to: URL(fileURLWithPath: args[2]))
    }
}
