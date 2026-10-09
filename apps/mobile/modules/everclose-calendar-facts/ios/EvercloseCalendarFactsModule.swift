import EventKit
import ExpoModulesCore
import Foundation

private final class CalendarReadDenied: Exception {
  override var reason: String { "Calendar reading is not allowed." }
}
private final class CalendarReadInvalid: Exception {
  override var reason: String { "Choose a valid calendar and a bounded date window." }
}
private final class CalendarReadTooLarge: Exception {
  override var reason: String { "Too many Calendar results. Choose a smaller date window." }
}

public final class EvercloseCalendarFactsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("EvercloseCalendarFacts")
    AsyncFunction("get") { (id: String) -> [String: Any]? in
      guard !id.isEmpty, id.count <= 1024 else { throw CalendarReadInvalid() }
      let store = try self.readStore()
      guard let event = store.calendarItem(withIdentifier: id) as? EKEvent else { return nil }
      return try self.facts(event)
    }
    AsyncFunction("calendars") { () -> [[String: String]] in
      let calendars = try self.readStore().calendars(for: .event)
      guard calendars.count <= 1000 else { throw CalendarReadTooLarge() }
      return calendars.map { ["id": $0.calendarIdentifier, "title": $0.title] }
    }
    AsyncFunction("find") { (calendarId: String, start: String, end: String, url: String) -> [[String: Any]] in
      let formatter = ISO8601DateFormatter()
      formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
      guard let startDate = formatter.date(from: start), let endDate = formatter.date(from: end),
        endDate > startDate, endDate.timeIntervalSince(startDate) <= 366 * 86400,
        url.count <= 500, url.hasPrefix("bonds://calendar/apple/") else { throw CalendarReadInvalid() }
      let store = try self.readStore()
      guard let calendar = store.calendar(withIdentifier: calendarId) else { throw CalendarReadInvalid() }
      let predicate = store.predicateForEvents(withStart: startDate, end: endDate, calendars: [calendar])
      var scanned = 0
      var matches: [EKEvent] = []
      store.enumerateEvents(matching: predicate) { event, stop in
        scanned += 1
        if scanned > 5000 { stop.pointee = true; return }
        if event.url?.absoluteString == url { matches.append(event) }
      }
      guard scanned <= 5000 else { throw CalendarReadTooLarge() }
      return try matches.map { try self.facts($0) }
    }
  }

  // Access is requested explicitly by the JS adapter; reads never open a permission prompt.
  private func readStore() throws -> EKEventStore {
    let status = EKEventStore.authorizationStatus(for: .event)
    if #available(iOS 17.0, *) {
      guard status == .fullAccess else { throw CalendarReadDenied() }
    } else {
      guard status == .authorized else { throw CalendarReadDenied() }
    }
    return EKEventStore()
  }

  private func facts(_ event: EKEvent) throws -> [String: Any] {
    guard let start = event.startDate, let end = event.endDate, end > start,
      let calendar = event.calendar else { throw CalendarReadInvalid() }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return [
      "id": event.calendarItemIdentifier, "calendar_id": calendar.calendarIdentifier,
      "title": event.title ?? "", "start": formatter.string(from: start), "end": formatter.string(from: end),
      "all_day": event.isAllDay, "time_zone": (event.timeZone ?? TimeZone.current).identifier,
      "url": event.url?.absoluteString as Any? ?? NSNull(),
      "recurring": event.hasRecurrenceRules || event.isDetached,
      "cancelled": event.status == .canceled
    ]
  }
}
