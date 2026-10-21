// Apple Reminders on this Mac, through EventKit. No model is involved.
//
//   reminders_tool dump                 every open reminder as JSON on stdout (read only)
//
// Build once:  xcrun swiftc -O -o state/reminders/reminders_tool listener/jobs/reminders_tool.swift
// The process that runs it needs the Reminders permission from macOS. It only reads.
import EventKit
import Foundation

let zone = TimeZone(identifier: "America/Los_Angeles")!
let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)

func fail(_ msg: String, _ code: Int32) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(code)
}

var granted = false
if #available(macOS 14.0, *) {
    store.requestFullAccessToReminders { ok, _ in granted = ok; sem.signal() }
} else {
    store.requestAccess(to: .reminder) { ok, _ in granted = ok; sem.signal() }
}
sem.wait()
guard granted else { fail("Reminders access not granted (status \(EKEventStore.authorizationStatus(for: .reminder).rawValue))", 2) }

let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime]
iso.timeZone = zone

func dateString(_ comps: DateComponents?) -> String? {
    guard let c = comps, let d = Calendar.current.date(from: c) else { return nil }
    if c.hour == nil { // all-day reminder: the date alone
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = zone
        return f.string(from: d)
    }
    return iso.string(from: d)
}

/** Every incomplete reminder across every list. */
func openReminders() -> [EKReminder] {
    let pred = store.predicateForIncompleteReminders(withDueDateStarting: nil, ending: nil, calendars: store.calendars(for: .reminder))
    var found: [EKReminder] = []
    store.fetchReminders(matching: pred) { found = $0 ?? []; sem.signal() }
    sem.wait()
    return found
}

let args = CommandLine.arguments.dropFirst()
switch args.first {
case "dump":
    var rows: [[String: Any]] = []
    for r in openReminders() {
        var row: [String: Any] = [
            "id": r.calendarItemIdentifier,
            "list": r.calendar.title,
            "title": r.title ?? "",
            "priority": r.priority,
            "has_alarm": !(r.alarms ?? []).isEmpty,
            "recurring": !(r.recurrenceRules ?? []).isEmpty,
        ]
        if let n = r.notes, !n.isEmpty { row["notes"] = n }
        if let c = r.creationDate { row["created"] = iso.string(from: c) }
        if let m = r.lastModifiedDate { row["modified"] = iso.string(from: m) }
        if let d = dateString(r.dueDateComponents) { row["due"] = d }
        rows.append(row)
    }
    rows.sort {
        ($0["list"] as! String, $0["due"] as? String ?? "9999", $0["title"] as! String)
            < ($1["list"] as! String, $1["due"] as? String ?? "9999", $1["title"] as! String)
    }
    let data = try! JSONSerialization.data(withJSONObject: rows, options: [.prettyPrinted, .sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    FileHandle.standardError.write("open reminders: \(rows.count)\n".data(using: .utf8)!)

default:
    fail("usage: reminders_tool dump", 64)
}
