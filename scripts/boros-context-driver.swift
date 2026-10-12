import Foundation
import CryptoKit

/// New public-corpus diagnostic. This helper stops before answer dispatch.
/// Source files come from the hash-verified Boros closure managed by Bun.
@main
enum BorosContextDriver {
    static let version = "boros-public-context-v1"
    struct Event: Decodable {
        let id: String
        let project_id: String
        let conversation_key: String
        let role: String
        let status: CaptureStatus
        let text: String
        let source_time: EventSourceTime?
    }
    struct Question: Decodable {
        let project_id: String
        let conversation_key: String
        let prompt: String
        let question_time: EventSourceTime?
    }
    struct Configuration: Decodable {
        let endpoint: String
        let model: String
        let system: String
        let temperature: Double
        let seed: Int
        let thinking: Bool
        let maximum_output: Int
        let context_limit: Int
        let safety_tokens: Int
        var settings: GenerationSettings {
            var value = GenerationSettings()
            value.profile = .customLocal
            value.endpointURL = endpoint
            value.endpointModel = model
            value.system = system
            value.temperature = temperature
            value.seed = seed
            value.thinkingEnabled = thinking
            value.maximumOutput = maximum_output
            value.endpointContextLimit = context_limit
            value.endpointSafetyTokens = safety_tokens
            return value
        }
    }
    struct Input: Decodable {
        let version: Int
        let corpus_sha256: String
        let cache_directory: String
        let work_directory: String
        let events: [Event]
        let question: Question
        let arms: [String]
        let configuration: Configuration
    }
    enum Failure: Error { case invalid }
    static func project(_ value: String) -> String { "optchat-comparison:" + value }
    static func key(_ project: String, _ conversation: String) -> String { project + "|" + conversation }
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func effectivePrompt(_ question: Question) -> String {
        guard let time = question.question_time else { return question.prompt }
        return "Question Date: " + time.originalValue + "\nQuestion: " + question.prompt
    }
    static func queryRange(_ question: Question) -> Range<Int>? {
        guard question.question_time != nil else { return nil }
        let end = effectivePrompt(question).utf8.count
        return (end - question.prompt.utf8.count)..<end
    }
    static func exactKeys(_ object: Any, required: Set<String>, optional: Set<String> = []) throws {
        guard let object = object as? [String: Any], required.isSubset(of: Set(object.keys)),
              Set(object.keys).isSubset(of: required.union(optional)) else { throw Failure.invalid }
    }
    static func validate(_ bytes: Data) throws -> Input {
        guard let raw = try JSONSerialization.jsonObject(with: bytes) as? [String: Any] else { throw Failure.invalid }
        try exactKeys(raw, required: ["version", "corpus_sha256", "cache_directory", "work_directory", "events", "question", "arms", "configuration"])
        guard let events = raw["events"] as? [Any], let question = raw["question"], let configuration = raw["configuration"] else { throw Failure.invalid }
        for event in events {
            try exactKeys(event, required: ["id", "project_id", "conversation_key", "role", "status", "text"], optional: ["source_time"])
        }
        try exactKeys(question, required: ["project_id", "conversation_key", "prompt"], optional: ["question_time"])
        try exactKeys(configuration, required: ["endpoint", "model", "system", "temperature", "seed", "thinking", "maximum_output", "context_limit", "safety_tokens"])
        let input = try JSONDecoder().decode(Input.self, from: bytes)
        guard input.version == 1, !input.events.isEmpty, input.events.count <= 100_000,
              Set(input.events.map(\.id)).count == input.events.count,
              input.events.allSatisfy({ ["user", "assistant"].contains($0.role) && $0.status == .complete }),
              !input.arms.isEmpty, Set(input.arms).count == input.arms.count,
              input.arms.allSatisfy({ ["ordinary_send", "lexical", "recent_only"].contains($0) }),
              input.configuration.model == Qwen38TextRendering.modelID,
              !input.configuration.thinking,
              input.configuration.maximum_output > 0, input.configuration.context_limit > 0,
              input.configuration.safety_tokens >= 0,
              input.cache_directory.hasPrefix("/"), input.work_directory.hasPrefix("/"),
              input.corpus_sha256.count == 64,
              input.corpus_sha256.allSatisfy({ $0.isHexDigit }),
              input.events.contains(where: { $0.project_id == input.question.project_id && $0.conversation_key == input.question.conversation_key }),
              let url = URL(string: input.configuration.endpoint), url.scheme == "http",
              ["127.0.0.1", "localhost", "::1"].contains(url.host ?? ""), url.user == nil, url.password == nil else {
            throw Failure.invalid
        }
        return input
    }
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard args.count == 2, args.allSatisfy({ $0.hasPrefix("/") }),
              !FileManager.default.fileExists(atPath: args[1]) else { exit(2) }
        do {
            let input = try validate(Data(contentsOf: URL(fileURLWithPath: args[0])))
            let run = Run(input: input, output: URL(fileURLWithPath: args[1]))
            DispatchQueue.global(qos: .userInitiated).async { run.begin() }
            dispatchMain()
        } catch { fputs("Boros context input rejected.\n", stderr); exit(1) }
    }
    final class RefusingRunner: AnswerAttemptRunning {
        private(set) var started = false
        var isRunning: Bool { false }
        func start(prompt: String, settings: GenerationSettings, conversation: Conversation,
                   onText: @escaping (String) -> Void, onComplete: @escaping (GenerationResult) -> Void) {
            started = true
            DispatchQueue.main.async {
                onComplete(GenerationResult(elapsed: 0, tokensPerSecond: nil, failure: "diagnostic_refused_dispatch", stopped: false))
            }
        }
        func cancel() {}
    }
    final class Run {
        let input: Input
        let output: URL
        var conversations: [String: String] = [:]
        var results: [[String: Any]] = []
        var armIndex = 0
        var coordinator: AnswerAttemptCoordinator?
        var cacheReused = false
        let started = DispatchTime.now().uptimeNanoseconds
        init(input: Input, output: URL) { self.input = input; self.output = output }
        var cacheURL: URL { URL(fileURLWithPath: input.cache_directory, isDirectory: true) }
        var baselineURL: URL { cacheURL.appendingPathComponent("baseline", isDirectory: true) }
        func begin() {
            do { try ensureCache(); advance() }
            catch { fail() }
        }
        func ensureCache() throws {
            let manager = FileManager.default
            let ready = cacheURL.appendingPathComponent("ready.json")
            if manager.fileExists(atPath: ready.path) {
                guard let object = try JSONSerialization.jsonObject(with: Data(contentsOf: ready)) as? [String: Any],
                      object["version"] as? String == version,
                      object["corpus_sha256"] as? String == input.corpus_sha256,
                      let map = object["conversations"] as? [String: String] else { throw Failure.invalid }
                conversations = map
                cacheReused = true
                return
            }
            let building = cacheURL.deletingLastPathComponent().appendingPathComponent(".building-" + UUID().uuidString, isDirectory: true)
            try manager.createDirectory(at: building, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
            do {
                let owner = try MemoryStore(directory: building.appendingPathComponent("baseline", isDirectory: true))
                for event in input.events {
                    let mapping = key(event.project_id, event.conversation_key)
                    if conversations[mapping] == nil {
                        conversations[mapping] = try owner.createConversation(projectID: project(event.project_id), title: "Public comparison corpus").id
                    }
                    let stored = try owner.append(conversationID: conversations[mapping]!, role: event.role == "user" ? .human : .assistant,
                        text: event.text, status: event.status, turnID: "public-turn:" + event.id, eventID: event.id, sourceTime: event.source_time)
                    guard stored.digest == digest(Data(event.text.utf8)), Data(stored.text.utf8) == Data(event.text.utf8) else { throw Failure.invalid }
                }
            }
            let record: [String: Any] = ["version": version, "corpus_sha256": input.corpus_sha256, "conversations": conversations]
            try privateWrite(try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), at: building.appendingPathComponent("ready.json"))
            if manager.fileExists(atPath: cacheURL.path) { throw Failure.invalid }
            try manager.moveItem(at: building, to: cacheURL)
        }
        func advance() {
            guard armIndex < input.arms.count else { finish(); return }
            let arm = input.arms[armIndex]
            let attempt = URL(fileURLWithPath: input.work_directory, isDirectory: true).appendingPathComponent("attempt-" + String(armIndex), isDirectory: true)
            do {
                try FileManager.default.createDirectory(at: attempt.deletingLastPathComponent(), withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
                try FileManager.default.copyItem(at: baselineURL, to: attempt)
                let owner = try MemoryStore(directory: attempt)
                // Use the application policy entry point. Current ordinary Send opens no index.
                let semantic = arm == "ordinary_send" ? try ApplicationSemanticMaintenance.openIndex(store: owner) : nil
                DispatchQueue.main.async { self.attempt(arm: arm, owner: owner, semantic: semantic, directory: attempt) }
            } catch { fail() }
        }
        func attempt(arm: String, owner: MemoryStore, semantic: SemanticIndex?, directory: URL) {
            let question = input.question
            let runner = RefusingRunner()
            var captured: AnswerAttemptPreparation?
            var coordinatorRef: AnswerAttemptCoordinator?
            guard let conversationID = conversations[key(question.project_id, question.conversation_key)] else { fail(); return }
            let value = AnswerAttemptCoordinator(store: owner, conversationID: conversationID,
                projectID: project(question.project_id), prompt: effectivePrompt(question), settings: input.configuration.settings,
                semanticIndex: semantic, retrievalStrategy: arm == "recent_only" ? .recentOnly : .hybrid,
                lexicalQueryUTF8Range: queryRange(question), semanticQueryUTF8Range: queryRange(question),
                semanticRetrieval: arm == "ordinary_send" ? .ordinarySend : .enabled, runner: runner,
                onStage: { stage, preparation in
                    if stage == .answering { captured = preparation; coordinatorRef?.cancel() }
                }, onText: { _ in }, onComplete: { completion, _ in
                    var item: [String: Any] = ["arm": arm, "runner_started": runner.started,
                        "preparation_completed": captured != nil,
                        "preparation_milliseconds": completion.timing.preparationMilliseconds as Any? ?? NSNull(),
                        "semantic_index_received": coordinatorRef?.preparationReceivesSemanticIndex as Any? ?? NSNull()]
                    do {
                        guard !runner.started else { throw Failure.invalid }
                        if let preparation = captured {
                            try self.describe(preparation, episodeID: completion.identifiers.episodeID, owner: owner, into: &item)
                        } else {
                            item["failure"] = "context_preparation_failed"
                            item["failure_code"] = completion.generation.failure as Any? ?? NSNull()
                        }
                    } catch { item = ["arm": arm, "failure": "context_receipt_failed", "preparation_completed": false] }
                    self.results.append(item)
                    self.coordinator = nil
                    DispatchQueue.main.async {
                        DispatchQueue.global(qos: .userInitiated).async {
                            try? FileManager.default.removeItem(at: directory)
                            self.armIndex += 1
                            self.advance()
                        }
                    }
                })
            coordinatorRef = value
            coordinator = value
            var accepted = false
            do { try value.accept(); accepted = true; try value.start() }
            catch {
                if accepted { value.terminate(reason: .failed) }
                else { fail() }
            }
        }
        func rangeText(owner: MemoryStore, eventID: String, offset: Int, count: Int) throws -> String {
            var cursor = offset
            var bytes = Data()
            while cursor < offset + count {
                let page = try owner.read(eventID: eventID, offset: cursor, length: min(4096, offset + count - cursor))
                guard page.offset == cursor, page.byteCount > 0 else { throw Failure.invalid }
                bytes.append(Data(page.text.utf8))
                cursor += page.byteCount
            }
            guard cursor == offset + count, let text = String(data: bytes, encoding: .utf8) else { throw Failure.invalid }
            return text
        }
        func source(owner: MemoryStore, id: String, offset: Int, count: Int, kind: String) throws -> [String: Any] {
            guard let original = input.events.first(where: { $0.id == id }),
                  let reference = try owner.sourceReference(eventID: id, projectID: project(original.project_id)),
                  reference.digest == digest(Data(original.text.utf8)), reference.byteCount == original.text.utf8.count,
                  offset >= 0, count >= 0, offset + count <= reference.byteCount else { throw Failure.invalid }
            let text = try rangeText(owner: owner, eventID: id, offset: offset, count: count)
            let slice = Data(Data(original.text.utf8).dropFirst(offset).prefix(count))
            guard Data(text.utf8) == slice else { throw Failure.invalid }
            return ["event_id": id, "conversation_key": original.conversation_key, "project_id": original.project_id,
                "role": original.role, "kind": kind, "offset": offset, "bytes": count, "source_bytes": reference.byteCount,
                "source_sha256": reference.digest, "excerpt_sha256": digest(slice), "text": text]
        }
        func describe(_ preparation: AnswerAttemptPreparation, episodeID: String, owner: MemoryStore,
                      into item: inout [String: Any]) throws {
            guard let audit = try JSONSerialization.jsonObject(with: preparation.contextAudit) as? [String: Any],
                  let workID = preparation.sourceSelectionWorkID,
                  let selectionBytes = try owner.episodeWork(episodeID: episodeID, operationID: workID)?.request.snapshot,
                  digest(selectionBytes) == preparation.sourceSelectionDigest,
                  let selection = try JSONSerialization.jsonObject(with: selectionBytes) as? [String: Any],
                  let recentIDs = selection["recent_source_ids"] as? [String],
                  let bodyBytes = try owner.episodeWork(episodeID: episodeID, operationID: preparation.answerWorkID)?.request.snapshot,
                  digest(bodyBytes) == preparation.requestDigest,
                  let body = try JSONSerialization.jsonObject(with: bodyBytes) as? [String: Any],
                  let messages = body["messages"] as? [[String: Any]] else { throw Failure.invalid }
            var sources: [[String: Any]] = []
            for id in recentIDs {
                guard let event = input.events.first(where: { $0.id == id }) else { throw Failure.invalid }
                sources.append(try source(owner: owner, id: id, offset: 0, count: event.text.utf8.count, kind: "recent"))
            }
            for historical in audit["historical_sources"] as? [[String: Any]] ?? [] {
                guard let id = historical["event_id"] as? String, let offset = historical["excerpt_offset"] as? Int,
                      let count = historical["excerpt_bytes"] as? Int, let sha = historical["excerpt_sha256"] as? String else { throw Failure.invalid }
                let retained = try source(owner: owner, id: id, offset: offset, count: count, kind: "historical")
                guard retained["excerpt_sha256"] as? String == sha else { throw Failure.invalid }
                sources.append(retained)
            }
            item["messages"] = messages
            item["request_body_base64"] = bodyBytes.base64EncodedString()
            item["selection_receipt_base64"] = selectionBytes.base64EncodedString()
            item["body_sha256"] = preparation.requestDigest
            item["selection_sha256"] = preparation.sourceSelectionDigest
            item["selection_receipt"] = selection
            item["context_audit"] = audit
            item["sources"] = sources
            item["prompt_tokens"] = preparation.admission.promptTokens
            item["recent_source_ids"] = recentIDs
        }
        func finish() {
            let document: [String: Any] = ["version": version, "corpus_sha256": input.corpus_sha256,
                "cache_reused": cacheReused, "attempts": results,
                "process_milliseconds": Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000]
            do {
                try privateWrite(try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]), at: output)
                let successful = results.filter { $0["preparation_completed"] as? Bool == true }.count
                print("{\"attempts\":\(results.count),\"prepared\":\(successful)}")
                exit(0)
            } catch { fail() }
        }
        func fail() { fputs("Boros context diagnostic failed.\n", stderr); exit(1) }
    }
    static func privateWrite(_ data: Data, at url: URL) throws {
        guard !FileManager.default.fileExists(atPath: url.path),
              FileManager.default.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600]) else { throw Failure.invalid }
    }
}
