// googleCalendar.js
// Helper functions for Google Calendar (uses Cloud Run service account)

const { google } = require("googleapis");


/**
 * Get an authenticated Calendar client using the Cloud Run service account.
 * On Cloud Run this uses Application Default Credentials.
 */
async function getCalendarClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });

  const authClient = await auth.getClient();
  return google.calendar({ version: "v3", auth: authClient });
}

/**
 * Get all events from a calendar, filtered to only those where the student
 * is an attendee.
 *
 * @param {string} calendarId  Google Calendar ID for the course
 * @param {string} studentEmail email to match in attendees
 * @param {object} opts        { timeMin, timeMax } (ISO8601 strings, optional)
 */


async function getEventsForStudent(calendarId, studentEmail) {
  const calendar = await getCalendarClient();

  // Use "now minus 5 minutes" as a safety buffer so you don't miss events
  const now = new Date();
  now.setMinutes(now.getMinutes() - 5);
  const timeMin = now.toISOString();

  const params = {
    calendarId,
    singleEvents: true,          // expand recurring events
    orderBy: "startTime",
    maxResults: 2500,
    conferenceDataVersion: 1,    // include conferenceData (meeting links)
    timeMin,                     // only upcoming events
  };

  const { data } = await calendar.events.list(params);
  const events = data.items || [];

  const lowered = studentEmail.trim().toLowerCase();

  // Still filter by attendee, but we won't expose attendees in the response.
  const filtered = events.filter((ev) => {
    const attendees = ev.attendees || [];
    return attendees.some(
      (a) => a.email && a.email.trim().toLowerCase() === lowered
    );
  });

  return filtered;
}

/**
 * Add a student as an attendee to a specific event
 * (for when they enroll in a cohort).
 */


module.exports = {
  getEventsForStudent,
};
