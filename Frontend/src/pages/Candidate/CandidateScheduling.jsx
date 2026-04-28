import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import axios from "axios";
import PublicLayout from "../../layouts/PublicLayout";
import "./CandidateScheduling.css";

const SCHEDULING_API_BASE = "http://localhost:5004/api/scheduling";

const slotKey = (slot) => `${slot?.start_time || ""}__${slot?.end_time || ""}`;

const formatDateOnly = (isoValue, timezoneName) => {
  if (!isoValue) return "N/A";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return String(isoValue);

  try {
    return new Intl.DateTimeFormat("en-US", {
      weekday: "long",
      month: "long",
      day: "2-digit",
      year: "numeric",
      ...(timezoneName ? { timeZone: timezoneName } : {}),
    }).format(parsed);
  } catch {
    return parsed.toLocaleDateString();
  }
};

const formatTimeOnly = (isoValue, timezoneName) => {
  if (!isoValue) return "N/A";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return String(isoValue);

  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...(timezoneName ? { timeZone: timezoneName } : {}),
    }).format(parsed);
  } catch {
    return parsed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  }
};

const formatDateTime = (isoValue, timezoneName) => {
  const date = formatDateOnly(isoValue, timezoneName);
  const time = formatTimeOnly(isoValue, timezoneName);
  return `${date}, ${time}`;
};

const CandidateScheduling = () => {
  const location = useLocation();
  const token = useMemo(
    () => new URLSearchParams(location.search).get("token") || "",
    [location.search]
  );

  const [schedule, setSchedule] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [rescheduling, setRescheduling] = useState(false);
  const [loadingAlternatives, setLoadingAlternatives] = useState(false);
  const [selectedSlotKey, setSelectedSlotKey] = useState("");
  const [showRescheduleOptions, setShowRescheduleOptions] = useState(false);
  const [showDeclineForm, setShowDeclineForm] = useState(false);
  const [declineReason, setDeclineReason] = useState("");
  const [preferredStartTimes, setPreferredStartTimes] = useState(["", "", ""]);

  const fetchPublicSchedule = useCallback(async () => {
    if (!token) {
      setError("Missing scheduling token in URL.");
      setLoading(false);
      return;
    }

    setLoading(true);
    setError("");

    try {
      const response = await axios.get(
        `${SCHEDULING_API_BASE}/public/${encodeURIComponent(token)}`
      );
      setSchedule(response.data);
    } catch (requestError) {
      const detail = requestError?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Unable to load scheduling details.");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchPublicSchedule();
  }, [fetchPublicSchedule]);

  useEffect(() => {
    if (!schedule) return;
    const suggestedSlots = Array.isArray(schedule.suggested_slots)
      ? schedule.suggested_slots
      : [];
    if (!suggestedSlots.length) {
      setSelectedSlotKey("");
      return;
    }

    if (!selectedSlotKey) {
      setSelectedSlotKey(slotKey(suggestedSlots[0]));
      return;
    }

    const stillExists = suggestedSlots.some((slot) => slotKey(slot) === selectedSlotKey);
    if (!stillExists) {
      setSelectedSlotKey(slotKey(suggestedSlots[0]));
    }
  }, [schedule, selectedSlotKey]);

  const suggestedSlots = Array.isArray(schedule?.suggested_slots)
    ? schedule.suggested_slots
    : [];

  const selectedSlot = suggestedSlots.find((slot) => slotKey(slot) === selectedSlotKey) || null;
  const isAlreadyConfirmed = ["confirmed", "rescheduled"].includes(
    String(schedule?.status || "").toLowerCase()
  );
  const displayTimezone = schedule?.candidate_timezone || schedule?.recruiter_timezone || "";

  const handleLoadAlternatives = async () => {
    if (!token) return;

    setLoadingAlternatives(true);
    setNotice("");

    try {
      const response = await axios.get(
        `${SCHEDULING_API_BASE}/public/${encodeURIComponent(token)}/alternatives`,
        {
          params: { top_n: 5 },
        }
      );

      const nextSlots = Array.isArray(response.data?.suggested_slots)
        ? response.data.suggested_slots
        : [];

      setSchedule((previous) =>
        previous
          ? { ...previous, suggested_slots: nextSlots }
          : { suggested_slots: nextSlots }
      );
      setNotice(response.data?.message || "Alternative slots loaded.");
    } catch (requestError) {
      const detail = requestError?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : "Unable to load alternatives.");
    } finally {
      setLoadingAlternatives(false);
    }
  };

  const handleStartReschedule = async () => {
    setShowRescheduleOptions(true);
    if (suggestedSlots.length > 0) {
      return;
    }
    await handleLoadAlternatives();
  };

  const handleConfirmAttendance = async () => {
    if (!token || !selectedSlot) return;

    setConfirming(true);
    setError("");
    setNotice("");

    try {
      await axios.post(
        `${SCHEDULING_API_BASE}/public/${encodeURIComponent(token)}/confirm`,
        {
          selected_slot: {
            start_time: selectedSlot.start_time,
            end_time: selectedSlot.end_time,
          },
          notes: "Confirmed by candidate from email link.",
        }
      );

      setNotice("Attendance confirmed successfully.");
      await fetchPublicSchedule();
    } catch (requestError) {
      const responseStatus = requestError?.response?.status;
      const detail = requestError?.response?.data?.detail;

      if (responseStatus === 409 && detail?.suggested_slots) {
        setSchedule((previous) =>
          previous
            ? { ...previous, suggested_slots: detail.suggested_slots }
            : { suggested_slots: detail.suggested_slots }
        );
        setNotice(detail?.message || "Selected slot is no longer available. Please choose another one.");
        return;
      }

      if (typeof detail === "string") {
        setError(detail);
      } else if (detail?.message) {
        setError(detail.message);
      } else {
        setError("Failed to confirm attendance. Please try again.");
      }
    } finally {
      setConfirming(false);
    }
  };

  const handleRescheduleAttendance = async () => {
    if (!token || !selectedSlot) return;

    setRescheduling(true);
    setError("");
    setNotice("");

    try {
      await axios.post(
        `${SCHEDULING_API_BASE}/public/${encodeURIComponent(token)}/reschedule`,
        {
          new_slot: {
            start_time: selectedSlot.start_time,
            end_time: selectedSlot.end_time,
          },
          notes: "Rescheduled by candidate from email link.",
        }
      );

      setNotice("Reschedule request sent to recruiter. We will email you once it is approved or declined.");
      setShowRescheduleOptions(false);
      await fetchPublicSchedule();
    } catch (requestError) {
      const responseStatus = requestError?.response?.status;
      const detail = requestError?.response?.data?.detail;

      if (responseStatus === 409 && detail?.suggested_slots) {
        setSchedule((previous) =>
          previous
            ? { ...previous, suggested_slots: detail.suggested_slots }
            : { suggested_slots: detail.suggested_slots }
        );
        setNotice(detail?.message || "Selected slot is no longer available. Please choose another one.");
        return;
      }

      if (typeof detail === "string") {
        setError(detail);
      } else if (detail?.message) {
        setError(detail.message);
      } else {
        setError("Failed to reschedule attendance. Please try again.");
      }
    } finally {
      setRescheduling(false);
    }
  };

  const durationMinutes = Number(schedule?.duration_minutes || 60);

  const handlePreferredTimeChange = (index, value) => {
    setPreferredStartTimes((previous) => {
      const next = [...previous];
      next[index] = value;
      return next;
    });
  };

  const toPreferredSlotsPayload = () => {
    return preferredStartTimes
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => {
        const start = new Date(value);
        const end = new Date(start.getTime() + (durationMinutes * 60 * 1000));
        return {
          start_time: start.toISOString(),
          end_time: end.toISOString(),
        };
      })
      .filter((slot) => !Number.isNaN(new Date(slot.start_time).getTime()));
  };

  const handleDeclineAndSuggest = async () => {
    if (!token) return;

    setDeclining(true);
    setError("");
    setNotice("");

    try {
      const preferredSlots = toPreferredSlotsPayload();
      const response = await axios.post(
        `${SCHEDULING_API_BASE}/public/${encodeURIComponent(token)}/decline`,
        {
          reason: declineReason,
          preferred_slots: preferredSlots,
          notes: "Candidate cannot attend the currently proposed day.",
        }
      );

      const nextSlots = Array.isArray(response.data?.suggested_slots)
        ? response.data.suggested_slots
        : [];

      setSchedule((previous) => {
        if (!previous) {
          return {
            status: response.data?.status || "suggested_slots_ready",
            suggested_slots: nextSlots,
            confirmed_slot: null,
            duration_minutes: durationMinutes,
          };
        }

        return {
          ...previous,
          status: response.data?.status || "suggested_slots_ready",
          suggested_slots: nextSlots,
          confirmed_slot: null,
        };
      });

      setShowDeclineForm(false);
      setDeclineReason("");
      setPreferredStartTimes(["", "", ""]);
      setNotice(response.data?.message || "New scheduling plan generated and sent by email.");
    } catch (requestError) {
      const detail = requestError?.response?.data?.detail;
      if (typeof detail === "string") {
        setError(detail);
      } else if (detail?.message) {
        setError(detail.message);
      } else {
        setError("Failed to generate a new scheduling plan.");
      }
    } finally {
      setDeclining(false);
    }
  };

  return (
    <PublicLayout>
      <div className="candidate-scheduling-page">
        <div className="candidate-scheduling-card">
          <h1>Confirm Attendance</h1>
          <p className="subtitle">
            Select your preferred interview slot, confirm your attendance, or change it later based on recruiter availability.
          </p>

          {loading && <p className="state-message">Loading scheduling details...</p>}
          {!loading && error && <p className="state-message error">{error}</p>}
          {!loading && !error && notice && <p className="state-message success">{notice}</p>}

          {!loading && !error && schedule && (
            <>
              <div className="status-row">
                <span className="label">Current status</span>
                <span className="value">{schedule.status || "N/A"}</span>
              </div>

              {schedule.candidate_action_expires_at && (
                <div className="status-row">
                  <span className="label">Link expires</span>
                  <span className="value">{formatDateTime(schedule.candidate_action_expires_at, displayTimezone)}</span>
                </div>
              )}

              {displayTimezone && (
                <div className="status-row">
                  <span className="label">Timezone</span>
                  <span className="value">{displayTimezone}</span>
                </div>
              )}

              {isAlreadyConfirmed && schedule.confirmed_slot && (
                <div className="confirmed-box">
                  <h2>Attendance already confirmed</h2>
                  <p>
                    <strong>Date:</strong> {formatDateOnly(schedule.confirmed_slot.start_time, displayTimezone)}
                  </p>
                  <p>
                    <strong>Time:</strong> {formatTimeOnly(schedule.confirmed_slot.start_time, displayTimezone)}
                  </p>
                  <p>
                    <strong>End:</strong> {formatTimeOnly(schedule.confirmed_slot.end_time, displayTimezone)}
                  </p>

                  {!showRescheduleOptions && (
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={handleStartReschedule}
                      disabled={loadingAlternatives}
                    >
                      {loadingAlternatives ? "Loading..." : "Change date / time"}
                    </button>
                  )}
                </div>
              )}

              {(!isAlreadyConfirmed || showRescheduleOptions) && (
                <>
                  <div className="slots-header">
                    <h2>{isAlreadyConfirmed ? "Choose a new slot" : "Available slots"}</h2>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={handleLoadAlternatives}
                      disabled={loadingAlternatives}
                    >
                      {loadingAlternatives ? "Loading..." : "Load alternatives"}
                    </button>
                  </div>

                  {suggestedSlots.length === 0 && (
                    <p className="state-message">No slots available at the moment.</p>
                  )}

                  {suggestedSlots.length > 0 && (
                    <div className="slots-list">
                      {suggestedSlots.map((slot) => {
                        const key = slotKey(slot);
                        const slotStartDate = formatDateOnly(slot.start_time, displayTimezone);
                        const slotStartTime = formatTimeOnly(slot.start_time, displayTimezone);
                        const slotEndTime = formatTimeOnly(slot.end_time, displayTimezone);
                        const isSelected = selectedSlotKey === key;
                        return (
                          <button
                            key={key}
                            type="button"
                            className={`slot-item ${selectedSlotKey === key ? "selected" : ""}`}
                            onClick={() => setSelectedSlotKey(key)}
                            aria-pressed={isSelected}
                          >
                            <div>
                              <p className="slot-time">
                                {slotStartDate} | {slotStartTime} - {slotEndTime}
                              </p>
                              <p className="slot-meta">Score: {slot.score ?? "N/A"}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {isAlreadyConfirmed ? (
                    <>
                      <button
                        type="button"
                        className="confirm-btn"
                        onClick={handleRescheduleAttendance}
                        disabled={rescheduling || !selectedSlot}
                      >
                        {rescheduling ? "Updating..." : "Confirm New Slot"}
                      </button>

                      <button
                        type="button"
                        className="decline-btn"
                        onClick={() => setShowRescheduleOptions(false)}
                      >
                        Keep current slot
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="confirm-btn"
                        onClick={handleConfirmAttendance}
                        disabled={confirming || !selectedSlot}
                      >
                        {confirming ? "Confirming..." : "Confirm Attendance"}
                      </button>

                      <button
                        type="button"
                        className="decline-btn"
                        onClick={() => setShowDeclineForm((previous) => !previous)}
                      >
                        Cannot attend this day
                      </button>
                    </>
                  )}

                  {showDeclineForm && (
                    <div className="decline-form">
                      <h3>Suggest other times</h3>
                      <p>
                        Tell us your preferred times. Our scheduling engine will generate a new plan and resend email.
                      </p>

                      <label htmlFor="decline-reason">Reason (optional)</label>
                      <textarea
                        id="decline-reason"
                        value={declineReason}
                        onChange={(event) => setDeclineReason(event.target.value)}
                        placeholder="I am not available on that day."
                      />

                      <div className="preferred-times-grid">
                        {[
                          { id: "first", value: preferredStartTimes[0] || "", index: 0 },
                          { id: "second", value: preferredStartTimes[1] || "", index: 1 },
                          { id: "third", value: preferredStartTimes[2] || "", index: 2 },
                        ].map((field) => (
                          <div key={`preferred-time-${field.id}`} className="preferred-time-field">
                            <label htmlFor={`preferred-start-${field.index}`}>
                              Preferred time {field.index + 1}
                            </label>
                            <input
                              id={`preferred-start-${field.index}`}
                              type="datetime-local"
                              value={field.value}
                              onChange={(event) => handlePreferredTimeChange(field.index, event.target.value)}
                            />
                          </div>
                        ))}
                      </div>

                      <button
                        type="button"
                        className="confirm-btn"
                        onClick={handleDeclineAndSuggest}
                        disabled={declining}
                      >
                        {declining ? "Generating new plan..." : "Submit and regenerate plan"}
                      </button>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </PublicLayout>
  );
};

export default CandidateScheduling;
