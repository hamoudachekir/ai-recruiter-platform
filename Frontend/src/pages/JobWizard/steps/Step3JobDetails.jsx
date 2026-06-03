import PropTypes from 'prop-types';
import { Actions } from '../wizardReducer';

// Native <option> elements ignore Tailwind on some browsers / OS dark modes,
// so we lock the dropdown menu colors with inline style as a safety net.
const OPTION_STYLE = { color: '#000', backgroundColor: '#fff' };
import {
  EMPLOYMENT_TYPES,
  INTERVIEW_LANGUAGE_OPTIONS,
  LANGUAGE_OPTIONS,
  SENIORITY_LEVELS,
  SKILL_OPTIONS,
  TOTAL_STEPS,
  WORKSPACE_TYPES,
} from '../wizardConfig';
import {
  Field,
  SelectInput,
  StepHeader,
  TextInput,
  WizardCard,
} from '../components/FormPrimitives';
import TagPicker from '../components/TagPicker';

/**
 * Step 3 — Job Details.
 * Two-column form. Required: title, location, interviewLanguage,
 * seniorityLevel, employmentType, workspaceType. Reuses TagPicker for
 * languages and skills with the suggestion lists from wizardConfig.
 */
export default function Step3JobDetails({ state, dispatch }) {
  const { data } = state;
  const setFields = (fields) => dispatch({ type: Actions.SET_FIELDS, fields });

  const handleChange = (field) => (e) => setFields({ [field]: e.target.value });

  return (
    <WizardCard>
      <StepHeader
        stepNumber={3}
        totalSteps={TOTAL_STEPS}
        title="Job Details"
        subtitle="The structured facts that drive matching, the interview prompts, and the published listing."
      />

      <div className="grid md:grid-cols-2 gap-x-5 gap-y-5">
        <Field
          label="Company Name"
          hint="Auto-populated from company context — you can override it for this job."
          htmlFor="job-companyName"
          className="md:col-span-2"
        >
          <TextInput
            id="job-companyName"
            value={data.companyName || ''}
            onChange={handleChange('companyName')}
            placeholder="e.g. NextHire"
          />
        </Field>

        <Field label="Job Title" required htmlFor="job-title">
          <TextInput
            id="job-title"
            value={data.title || ''}
            onChange={handleChange('title')}
            placeholder="e.g. Senior Cloud Engineer"
          />
        </Field>

        <Field label="Location" required htmlFor="job-location">
          <TextInput
            id="job-location"
            value={data.location || ''}
            onChange={handleChange('location')}
            placeholder="e.g. Paris, France"
          />
        </Field>

        <Field label="Salary (€)" hint="Optional — leave blank to keep it private." htmlFor="job-salary">
          <TextInput
            id="job-salary"
            type="number"
            min="0"
            value={data.salary ?? ''}
            onChange={handleChange('salary')}
            placeholder="45000"
          />
        </Field>

        <Field
          label="Interview Language"
          required
          htmlFor="job-interviewLanguage"
          hint="The language the AI interviewer (Nour) will speak during the call. Only French and English are supported today."
        >
          <SelectInput
            id="job-interviewLanguage"
            value={data.interviewLanguage || ''}
            onChange={handleChange('interviewLanguage')}
          >
            <option value="" disabled style={OPTION_STYLE}>Select…</option>
            {INTERVIEW_LANGUAGE_OPTIONS.map((lang) => (
              <option key={lang} value={lang} style={OPTION_STYLE}>{lang}</option>
            ))}
          </SelectInput>
        </Field>

        <Field label="Seniority Level" required htmlFor="job-seniorityLevel">
          <SelectInput
            id="job-seniorityLevel"
            value={data.seniorityLevel || ''}
            onChange={handleChange('seniorityLevel')}
          >
            <option value="" disabled style={OPTION_STYLE}>Select…</option>
            {SENIORITY_LEVELS.map((s) => (
              <option key={s} value={s} style={OPTION_STYLE}>{s}</option>
            ))}
          </SelectInput>
        </Field>

        <Field label="Employment Type" required htmlFor="job-employmentType">
          <SelectInput
            id="job-employmentType"
            value={data.employmentType || ''}
            onChange={handleChange('employmentType')}
          >
            <option value="" disabled style={OPTION_STYLE}>Select…</option>
            {EMPLOYMENT_TYPES.map((t) => (
              <option key={t} value={t} style={OPTION_STYLE}>{t}</option>
            ))}
          </SelectInput>
        </Field>

        <Field label="Workspace Type" required htmlFor="job-workspaceType">
          <SelectInput
            id="job-workspaceType"
            value={data.workspaceType || ''}
            onChange={handleChange('workspaceType')}
          >
            <option value="" disabled style={OPTION_STYLE}>Select…</option>
            {WORKSPACE_TYPES.map((t) => (
              <option key={t} value={t} style={OPTION_STYLE}>{t}</option>
            ))}
          </SelectInput>
        </Field>

        <Field
          label="Required Languages"
          hint="Type and press Enter to add. Pick from suggestions or add custom languages."
          className="md:col-span-2"
        >
          <TagPicker
            values={data.languages || []}
            onChange={(next) => setFields({ languages: next })}
            suggestions={LANGUAGE_OPTIONS}
            ariaLabel="Required Languages"
            placeholder="Type and press Enter"
          />
        </Field>

        <Field
          label="Required Skills"
          hint="Type and press Enter to add. Pick from suggestions or add custom skills."
          className="md:col-span-2"
        >
          <TagPicker
            values={data.skills || []}
            onChange={(next) => setFields({ skills: next })}
            suggestions={SKILL_OPTIONS}
            ariaLabel="Required Skills"
            placeholder="Type and press Enter"
          />
        </Field>
      </div>
    </WizardCard>
  );
}

Step3JobDetails.propTypes = {
  state: PropTypes.shape({
    data: PropTypes.object.isRequired,
  }).isRequired,
  dispatch: PropTypes.func.isRequired,
};
