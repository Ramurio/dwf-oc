// A projection of persisted visit fields, never a new piece of durable state.
// Children share the group's request-freezing boundary, but retain their own outcomes/acks.
export function admissionStage(visit, group = visit) {
  if (visit.verdict || visit.error) return 'finished';
  if (visit.admitted) return 'admitted';
  // Only explicit false proves that no request could have been sent. Legacy visits
  // without this marker must retry the saved input, not reopen preparation.
  return group.admissionStarted === false ? 'prepared' : 'admission_started';
}
