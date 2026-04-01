param(
    [string]$SchedulingBaseUrl = "http://localhost:5004",
    [string]$BackendBaseUrl = "http://localhost:3001",
    [string]$CandidateId = "69cb04ad8c22bc5de2283c88",
    [string]$RecruiterId = "69cb03a88c22bc5de2283c6f",
    [string]$JobIdPrimary = "69cbe8ef21147a473d6ba165",
    [string]$JobIdSecondary = "69cb042b8c22bc5de2283c7f"
)

$ErrorActionPreference = "Stop"

function Assert-True {
    param(
        [bool]$Condition,
        [string]$Message
    )

    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Invoke-JsonPost {
    param(
        [string]$Url,
        [hashtable]$Body
    )

    return (curl.exe -s -X POST $Url -H "Content-Type: application/json" -d ($Body | ConvertTo-Json -Depth 10) | ConvertFrom-Json)
}

function Invoke-HttpStatusPost {
    param(
        [string]$Url,
        [hashtable]$Body
    )

    return (curl.exe -s -o NUL -w "%{http_code}" -X POST $Url -H "Content-Type: application/json" -d ($Body | ConvertTo-Json -Depth 10))
}

$report = [ordered]@{
    startedAt = (Get-Date).ToString("o")
    schedulingBaseUrl = $SchedulingBaseUrl
    backendBaseUrl = $BackendBaseUrl
    checks = [ordered]@{}
}

# 1) Basic service reachability
$schedulingHealth = curl.exe -s -o NUL -w "%{http_code}" "$SchedulingBaseUrl/health"
$calendarStatusRaw = curl.exe -s "$BackendBaseUrl/api/recruiter/calendar/status/$RecruiterId"
$calendarStatus = $calendarStatusRaw | ConvertFrom-Json

Assert-True ($schedulingHealth -eq "200") "Scheduling health endpoint is not reachable"
Assert-True ([bool]$calendarStatus.connected) "Recruiter calendar is not connected"
Assert-True (-not [bool]$calendarStatus.tokenExpired) "Recruiter calendar token is expired"

$report.checks.serviceAndCalendarStatus = [ordered]@{
    schedulingHealth = $schedulingHealth
    calendarConnected = [bool]$calendarStatus.connected
    tokenExpired = [bool]$calendarStatus.tokenExpired
}

# 2) Main workflow: start -> confirm -> verify final state
$appMain = "wf-main-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$startMain = Invoke-JsonPost -Url "$SchedulingBaseUrl/api/scheduling/start" -Body @{
    candidate_id = $CandidateId
    recruiter_id = $RecruiterId
    job_id = $JobIdPrimary
    application_id = $appMain
    interview_type = "video"
    interview_mode = "synchronous"
    duration_minutes = 60
}

Assert-True ($startMain.status -eq "suggested_slots_ready") "Scheduling start did not return suggested slots"
Assert-True (($startMain.suggested_slots | Measure-Object).Count -gt 0) "No suggested slots returned"

$slotMain = $startMain.suggested_slots[0]
$slotMainStartIso = ([datetime]$slotMain.start_time).ToString("o")
$slotMainEndIso = ([datetime]$slotMain.end_time).ToString("o")

$confirmMain = Invoke-JsonPost -Url "$SchedulingBaseUrl/api/scheduling/confirm" -Body @{
    interview_schedule_id = $startMain.interview_schedule_id
    selected_slot = @{
        start_time = $slotMainStartIso
        end_time = $slotMainEndIso
    }
    location = "Google Meet"
    notes = "E2E workflow test"
}

$finalMain = curl.exe -s "$SchedulingBaseUrl/api/scheduling/$($startMain.interview_schedule_id)" | ConvertFrom-Json

Assert-True ($confirmMain.status -eq "confirmed") "Confirm endpoint did not return confirmed status"
Assert-True ($finalMain.status -eq "confirmed") "Final schedule is not confirmed"
Assert-True ($finalMain.email_status -eq "sent") "Invitation email was not marked as sent"
Assert-True (-not [string]::IsNullOrWhiteSpace([string]$finalMain.calendar_event_id)) "Calendar event ID missing"
Assert-True (-not [string]::IsNullOrWhiteSpace([string]$finalMain.meeting_link)) "Meeting link missing"

$report.checks.mainWorkflow = [ordered]@{
    applicationId = $appMain
    scheduleId = $startMain.interview_schedule_id
    startStatus = $startMain.status
    suggestedSlotsCount = ($startMain.suggested_slots | Measure-Object).Count
    confirmStatus = $confirmMain.status
    finalStatus = $finalMain.status
    finalEmailStatus = $finalMain.email_status
    hasCalendarEventId = (-not [string]::IsNullOrWhiteSpace([string]$finalMain.calendar_event_id))
    hasMeetingLink = (-not [string]::IsNullOrWhiteSpace([string]$finalMain.meeting_link))
}

# 3) Suggestion aggressiveness + conflict protection scenario
$appA = "wf-a-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$appB = "wf-b-" + [guid]::NewGuid().ToString("N").Substring(0, 8)

$startA = Invoke-JsonPost -Url "$SchedulingBaseUrl/api/scheduling/start" -Body @{
    candidate_id = $CandidateId
    recruiter_id = $RecruiterId
    job_id = $JobIdPrimary
    application_id = $appA
    interview_type = "video"
    interview_mode = "synchronous"
    duration_minutes = 60
}

$startB = Invoke-JsonPost -Url "$SchedulingBaseUrl/api/scheduling/start" -Body @{
    candidate_id = $CandidateId
    recruiter_id = $RecruiterId
    job_id = $JobIdSecondary
    application_id = $appB
    interview_type = "video"
    interview_mode = "synchronous"
    duration_minutes = 60
}

$slotA = $startA.suggested_slots[0]
$slotB = $startB.suggested_slots[0]

Assert-True (
    -not (
        $slotA.start_time -eq $slotB.start_time -and
        $slotA.end_time -eq $slotB.end_time
    )
) "Back-to-back starts still returned the same top slot"

$slotAStartIso = ([datetime]$slotA.start_time).ToString("o")
$slotAEndIso = ([datetime]$slotA.end_time).ToString("o")

$confirmAStatus = Invoke-HttpStatusPost -Url "$SchedulingBaseUrl/api/scheduling/confirm" -Body @{
    interview_schedule_id = $startA.interview_schedule_id
    selected_slot = @{
        start_time = $slotAStartIso
        end_time = $slotAEndIso
    }
    location = "Google Meet"
    notes = "Conflict safety test - first"
}

$confirmBStatus = Invoke-HttpStatusPost -Url "$SchedulingBaseUrl/api/scheduling/confirm" -Body @{
    interview_schedule_id = $startB.interview_schedule_id
    selected_slot = @{
        start_time = $slotAStartIso
        end_time = $slotAEndIso
    }
    location = "Google Meet"
    notes = "Conflict safety test - duplicate"
}

Assert-True ($confirmAStatus -eq "200") "First confirm should succeed"
Assert-True ($confirmBStatus -eq "400") "Second confirm with same slot should be rejected"

$report.checks.aggressiveSuggestionAndConflictSafety = [ordered]@{
    appA = $appA
    appB = $appB
    scheduleA = $startA.interview_schedule_id
    scheduleB = $startB.interview_schedule_id
    topSlotA = $slotA.start_time
    topSlotB = $slotB.start_time
    topSlotsDifferent = $true
    confirmAHttp = $confirmAStatus
    confirmBDuplicateHttp = $confirmBStatus
}

$report.completedAt = (Get-Date).ToString("o")
$report.result = "PASS"

$report | ConvertTo-Json -Depth 8
