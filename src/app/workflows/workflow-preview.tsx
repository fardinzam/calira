type PreviewConfig = {
  calendarId: string;
  gmail: { subject: string; body: string };
};

const example = {
  name: "Alex Rivera",
  email: "alex@example.com",
  requestType: "Consultation",
  requestedDate: "2026-10-15",
  requestedTime: "10:00",
  notes: "Please call first.",
};

function fillTemplate(template: string) {
  return template.replace(
    /{{(name|requestType|requestedDate|requestedTime|notes)}}/g,
    (_match, key: keyof typeof example) => example[key],
  );
}

export default function WorkflowPreview({ config }: { config: PreviewConfig }) {
  return (
    <section
      aria-label="Workflow preview"
      className="rounded border border-gray-300 p-4"
    >
      <h2 className="text-lg font-semibold">Review with example values</h2>
      <p className="mt-1 text-sm text-gray-700">
        Example values only. No Form response is loaded and no Google action
        runs here.
      </p>
      <dl className="mt-4 grid gap-3 text-sm">
        <div>
          <dt className="font-medium">Example name</dt>
          <dd>{example.name}</dd>
        </div>
        <div>
          <dt className="font-medium">Example email</dt>
          <dd>{example.email}</dd>
        </div>
        <div>
          <dt className="font-medium">Example request type</dt>
          <dd>{example.requestType}</dd>
        </div>
        <div>
          <dt className="font-medium">Example requested date and time</dt>
          <dd>
            {example.requestedDate} {example.requestedTime}
          </dd>
        </div>
        <div>
          <dt className="font-medium">Example notes</dt>
          <dd>{example.notes}</dd>
        </div>
      </dl>
      <div className="mt-5 space-y-3 text-sm">
        <p>
          <strong>Filter:</strong> {example.requestType} = Consultation
        </p>
        <p>
          <strong>Calendar ID:</strong>{" "}
          {config.calendarId.trim() || "Add a Calendar ID"}
        </p>
        <p>
          <strong>Calendar title:</strong> Consultation request — {example.name}
        </p>
        <p>
          <strong>Calendar start:</strong> {example.requestedDate}{" "}
          {example.requestedTime} America/Los_Angeles
        </p>
        <p>
          <strong>Calendar end:</strong> {example.requestedDate} 11:00
          America/Los_Angeles (60 minutes later)
        </p>
        <p>
          <strong>Calendar description:</strong> {example.notes}
        </p>
        <p>
          <strong>Gmail recipient:</strong> {example.email}
        </p>
        <p>
          <strong>Gmail subject:</strong>{" "}
          {fillTemplate(config.gmail.subject) || "Add a subject"}
        </p>
        <p className="whitespace-pre-wrap">
          <strong>Gmail body:</strong>{" "}
          {fillTemplate(config.gmail.body) || "Add a body"}
        </p>
      </div>
    </section>
  );
}
