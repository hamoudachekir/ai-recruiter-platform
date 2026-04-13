import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import axios from "axios";
import PublicLayout from "../../layouts/PublicLayout";
import "./CandidateScheduling.css";

const SCHEDULING_API_BASE = "http://localhost:5004/api/scheduling";

const slotKey = (slot) => `${slot?.start_time || ""}__${slot?.end_time || ""}`;

const formatDateTime = (isoValue) => {
  if (!isoValue) return "N/A";
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) return String(isoValue);
  return parsed.toLocaleString();
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
  const [loadingAlternatives, setLoadingAlternatives] = useState(false);
  const [selectedSlotKey, setSelectedSlotKey] = useState("");
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
            Select your preferred interview slot and confirm your attendance.
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
                  <span className="value">{formatDateTime(schedule.candidate_action_expires_at)}</span>
                </div>
              )}

              {isAlreadyConfirmed && schedule.confirmed_slot && (
                <div className="confirmed-box">
                  <h2>Attendance already confirmed</h2>
                  <p>
                    <strong>Start:</strong> {formatDateTime(schedule.confirmed_slot.start_time)}
                  </p>
                  <p>
                    <strong>End:</strong> {formatDateTime(schedule.confirmed_slot.end_time)}
                  </p>
                </div>
              )}

              {!isAlreadyConfirmed && (
                <>
                  <div className="slots-header">
                    <h2>Available slots</h2>
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
                        const slotStart = formatDateTime(slot.start_time);
                        const slotEnd = formatDateTime(slot.end_time);
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
                                {slotStart} - {slotEnd}
                              </p>
                              <p className="slot-meta">Score: {slot.score ?? "N/A"}</p>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}

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
