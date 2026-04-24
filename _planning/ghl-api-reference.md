# GoHighLevel API v2 — Reference pro Sparkbot

Extraído de https://github.com/GoHighLevel/highlevel-api-docs em 2026-04-24.

## Convenções

- Base URL: `https://services.leadconnectorhq.com`
- Auth header: `Authorization: Bearer <location_token>` — obtido via Token Refresher
- `Version: 2021-07-28` header obrigatório
- Content-Type: `application/json`
- IDs do GHL são ~20 chars alfanuméricos (ex: `ErpM2X8vR1U4IrRTZnKX`). NUNCA inventar IDs no código do agent.
- Timestamps: ISO 8601 com `Z` (UTC) no spec (ex: `2020-10-25T11:00:00Z`). Offset `+HH:MM` funciona na prática.

## 🚨 GOTCHAS (descobertos via 422/400 em prod)

### Create Task (POST `/contacts/{id}/tasks`)

**Campos obrigatórios:** `title`, `dueDate`, `completed`.

- **`completed: false`** é OBRIGATÓRIO no payload. Sem ele → 422 `"completed must be a boolean value"`.
- Esse é o principal gotcha — fácil esquecer porque parece redundante (task nova nunca está completed).

### Search Contacts (POST `/contacts/search`)

- Endpoint novo V2. Body schema está vazio no spec oficial — GHL não publicou detalhes ainda.
- Por isso ainda usamos `GET /contacts/?query=X&locationId=Y&limit=N` (marcado como deprecated). TODO: migrar quando spec for publicada.

### Tags add/remove

- Add: **POST** `/contacts/{id}/tags` body `{ "tags": ["tag1", "tag2"] }`
- Remove: **DELETE** `/contacts/{id}/tags` body `{ "tags": ["tag1"] }`

### Contact IDs

- LLM tende a inventar IDs tipo `"2"` ou `"pedro"` — rejeita antes de bater na API com `validateGhlId()`.
- Sempre obter ID via search_contacts ou get_contact primeiro.

---

## Endpoints

## Contacts


### POST `/contacts/` — Create Contact

**Body** (application/json):

  - `firstName` [opt]: string e.g. `'Rosan'`
  - `lastName` [opt]: string e.g. `'Deo'`
  - `name` [opt]: string e.g. `'Rosan Deo'`
  - `email` [opt]: string e.g. `'rosan@deos.com'`
  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'`
  - `gender` [opt]: string e.g. `'male'`
  - `phone` [opt]: string e.g. `'+1 888-888-8888'`
  - `address1` [opt]: string e.g. `'3535 1st St N'`
  - `city` [opt]: string e.g. `'Dolomite'`
  - `state` [opt]: string e.g. `'AL'`
  - `postalCode` [opt]: string e.g. `'35061'`
  - `website` [opt]: string e.g. `'https://www.tesla.com'`
  - `timezone` [opt]: string e.g. `'America/Chihuahua'`
  - `dnd` [opt]: boolean e.g. `True`
  - `dndSettings` [opt]: DndSettingsSchema
  - `inboundDndSettings` [opt]: InboundDndSettingsSchema
  - `tags` [opt]: array e.g. `['nisi sint commodo amet', 'consequat']`
  - `customFields` [opt]: array
  - `source` [opt]: string e.g. `'public api'`
  - `country` [opt]: string e.g. `'US'`
  - `companyName` [opt]: string e.g. `'DGS VolMAX'`
  - `assignedTo` [opt]: string e.g. `'y0BeYjuRIlDwsDcOHOJo'` — User's Id

### GET `/contacts/` — Get Contacts ⚠️ DEPRECATED

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `startAfterId` [opt]: string — Start After Id
  - `startAfter` [opt]: number — Start Afte
  - `query` [opt]: string — Contact Query
  - `limit` [opt]: number — Limit Per Page records count. will allow maximum up to 100 a

### POST `/contacts/bulk/business` — Add/Remove Contacts From Business

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'PX8m5VwxEbcpFlzYEPVG'`
  - `ids` [REQ]: array e.g. `['IDqvFHGColiyK6jiatuz', 'pOC0uJ97VYOKH2m3fkMD']`
  - `businessId` [REQ]: string e.g. `'63b7ec34ea409a9a8bd2a4ff'`

### POST `/contacts/bulk/tags/update/{type}` — Update Contacts Tags

**Body** (application/json):

  - `contacts` [REQ]: array e.g. `['qFSqySFkVvNzOSqgGqFi', 'abcdef', 'qFSqySFkVvNzOS` — list of contact ids to be processed
  - `tags` [REQ]: array e.g. `['tag-1', 'tag-2']` — list of tags to be added or removed
  - `locationId` [REQ]: string e.g. `'asdrwHvLUxlfw5SqKVCN'` — location id from where the bulk request is executed
  - `removeAllTags` [opt]: boolean e.g. `'false'` — Option to implement remove all tags. if true, all tags will 

### GET `/contacts/business/{businessId}` — Get Contacts By BusinessId

**Query params:**

  - `limit` [opt]: string
  - `locationId` [REQ]: string
  - `skip` [opt]: string
  - `query` [opt]: string

### POST `/contacts/search` — Search Contacts

**Body** (application/json):

  (schema vazio no spec oficial)

### GET `/contacts/search/duplicate` — Get Duplicate Contact

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `number` [opt]: string — Phone Number - Pass in URL Encoded form. i.e +1423164516 wil
  - `email` [opt]: string — Email - Pass in URL Encoded form. i.e test+abc@gmail.com wil

### POST `/contacts/upsert` — Upsert Contact

**Body** (application/json):

  - `firstName` [opt]: string e.g. `'Rosan'`
  - `lastName` [opt]: string e.g. `'Deo'`
  - `name` [opt]: string e.g. `'Rosan Deo'`
  - `email` [opt]: string e.g. `'rosan@deos.com'`
  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'`
  - `gender` [opt]: string e.g. `'male'`
  - `phone` [opt]: string e.g. `'+1 888-888-8888'`
  - `address1` [opt]: string e.g. `'3535 1st St N'`
  - `city` [opt]: string e.g. `'Dolomite'`
  - `state` [opt]: string e.g. `'AL'`
  - `postalCode` [opt]: string e.g. `'35061'`
  - `website` [opt]: string e.g. `'https://www.tesla.com'`
  - `timezone` [opt]: string e.g. `'America/Chihuahua'`
  - `dnd` [opt]: boolean e.g. `True`
  - `dndSettings` [opt]: DndSettingsSchema
  - `inboundDndSettings` [opt]: InboundDndSettingsSchema
  - `tags` [opt]: array e.g. `['nisi sint commodo amet', 'consequat']` — This field will overwrite all current tags associated with t
  - `customFields` [opt]: array
  - `source` [opt]: string e.g. `'public api'`
  - `country` [opt]: string e.g. `'US'`
  - `companyName` [opt]: string e.g. `'DGS VolMAX'`
  - `assignedTo` [opt]: string e.g. `'y0BeYjuRIlDwsDcOHOJo'` — User's Id

### GET `/contacts/{contactId}` — Get Contact

### PUT `/contacts/{contactId}` — Update Contact

**Body** (application/json):

  - `firstName` [opt]: string e.g. `'rosan'`
  - `lastName` [opt]: string e.g. `'Deo'`
  - `name` [opt]: string e.g. `'rosan Deo'`
  - `email` [opt]: string e.g. `'rosan@deos.com'`
  - `phone` [opt]: string e.g. `'+1 888-888-8888'`
  - `address1` [opt]: string e.g. `'3535 1st St N'`
  - `city` [opt]: string e.g. `'Dolomite'`
  - `state` [opt]: string e.g. `'AL'`
  - `postalCode` [opt]: string e.g. `'35061'`
  - `website` [opt]: string e.g. `'https://www.tesla.com'`
  - `timezone` [opt]: string e.g. `'America/Chihuahua'`
  - `dnd` [opt]: boolean e.g. `True`
  - `dndSettings` [opt]: DndSettingsSchema
  - `inboundDndSettings` [opt]: InboundDndSettingsSchema
  - `tags` [opt]: array e.g. `['nisi sint commodo amet', 'consequat']` — This field will overwrite all current tags associated with t
  - `customFields` [opt]: array
  - `source` [opt]: string e.g. `'public api'`
  - `country` [opt]: string e.g. `'US'`
  - `assignedTo` [opt]: string e.g. `'y0BeYjuRIlDwsDcOHOJo'` — User's Id

### DELETE `/contacts/{contactId}` — Delete Contact

### GET `/contacts/{contactId}/appointments` — Get Appointments for Contact

### DELETE `/contacts/{contactId}/campaigns/removeAll` — Remove Contact From Every Campaign

### POST `/contacts/{contactId}/campaigns/{campaignId}` — Add Contact to Campaign

**Body** (application/json):

  (schema vazio no spec oficial)

### DELETE `/contacts/{contactId}/campaigns/{campaignId}` — Remove Contact From Campaign

### POST `/contacts/{contactId}/followers` — Add Followers

**Body** (application/json):

  - `followers` [REQ]: array e.g. `['sx6wyHhbFdRXh302Lunr', 'sx6wyHhbFdRXh302Lunr']`

### DELETE `/contacts/{contactId}/followers` — Remove Followers

**Body** (application/json):

  - `followers` [REQ]: array e.g. `['sx6wyHhbFdRXh302Lunr', 'sx6wyHhbFdRXh302Lunr']`

### GET `/contacts/{contactId}/notes` — Get All Notes

### POST `/contacts/{contactId}/notes` — Create Note

**Body** (application/json):

  - `userId` [opt]: string e.g. `'GCs5KuzPqTls7vWclkEV'`
  - `body` [REQ]: string e.g. `'lorem ipsum'`

### GET `/contacts/{contactId}/notes/{id}` — Get Note

### PUT `/contacts/{contactId}/notes/{id}` — Update Note

**Body** (application/json):

  - `userId` [opt]: string e.g. `'GCs5KuzPqTls7vWclkEV'`
  - `body` [REQ]: string e.g. `'lorem ipsum'`

### DELETE `/contacts/{contactId}/notes/{id}` — Delete Note

### POST `/contacts/{contactId}/tags` — Add Tags

**Body** (application/json):

  - `tags` [REQ]: array e.g. `['minim', 'velit magna']`

### DELETE `/contacts/{contactId}/tags` — Remove Tags

**Body** (application/json):

  - `tags` [REQ]: array e.g. `['minim', 'velit magna']`

### GET `/contacts/{contactId}/tasks` — Get all Tasks

### POST `/contacts/{contactId}/tasks` — Create Task

**Body** (application/json):

  - `title` [REQ]: string e.g. `'First Task'`
  - `body` [opt]: string e.g. `'loram ipsum'`
  - `dueDate` [REQ]: string e.g. `'2020-10-25T11:00:00Z'`
  - `completed` [REQ]: boolean e.g. `True`
  - `assignedTo` [opt]: string e.g. `'hxHGVRb1YJUscrCB8eXK'`

### GET `/contacts/{contactId}/tasks/{taskId}` — Get Task

### PUT `/contacts/{contactId}/tasks/{taskId}` — Update Task

**Body** (application/json):

  - `title` [opt]: string e.g. `'First Task'`
  - `body` [opt]: string e.g. `'loram ipsum'`
  - `dueDate` [opt]: string e.g. `'2020-10-25T11:00:00Z'`
  - `completed` [opt]: boolean e.g. `True`
  - `assignedTo` [opt]: string e.g. `'hxHGVRb1YJUscrCB8eXK'`

### DELETE `/contacts/{contactId}/tasks/{taskId}` — Delete Task

### PUT `/contacts/{contactId}/tasks/{taskId}/completed` — Update Task Completed

**Body** (application/json):

  - `completed` [REQ]: boolean e.g. `True`

### POST `/contacts/{contactId}/workflow/{workflowId}` — Add Contact to Workflow

**Body** (application/json):

  - `eventStartTime` [opt]: string e.g. `'2021-06-23T03:30:00+01:00'`

### DELETE `/contacts/{contactId}/workflow/{workflowId}` — Delete Contact from Workflow

**Body** (application/json):

  - `eventStartTime` [opt]: string e.g. `'2021-06-23T03:30:00+01:00'`

## Calendars & Appointments


### GET `/calendars/` — Get Calendars

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `groupId` [opt]: string — Group Id
  - `showDrafted` [opt]: boolean — Show drafted

### POST `/calendars/` — Create Calendar

**Body** (application/json):

  - `isActive` [opt]: boolean — Should the created calendar be active or draft
  - `notifications` [opt]: array — 🚨 Deprecated! Please use 'Calendar Notifications APIs' inste
  - `locationId` [REQ]: string e.g. `'ocQHyuzHvysMo5N5VsXc'`
  - `groupId` [opt]: string e.g. `'BqTwX8QFwXzpegMve9EQ'` — Group Id
  - `teamMembers` [opt]: array — Team members are required for calendars of type: Round Robin
  - `eventType` [opt]: string
  - `name` [REQ]: string e.g. `'test calendar'`
  - `description` [opt]: string e.g. `'this is used for testing'`
  - `slug` [opt]: string e.g. `'test1'`
  - `widgetSlug` [opt]: string e.g. `'test1'`
  - `calendarType` [opt]: string
  - `widgetType` [opt]: string e.g. `'classic'` — Calendar widget type. Choose "default" for "neo" and "classi
  - `eventTitle` [opt]: string
  - `eventColor` [opt]: string
  - `meetingLocation` [opt]: string — 🚨 Deprecated! Use `locationConfigurations.location` or `team
  - `locationConfigurations` [opt]: array — Meeting location configuration for event calendar
  - `slotDuration` [opt]: number — This controls the duration of the meeting
  - `slotDurationUnit` [opt]: string — Unit for slot duration.
  - `slotInterval` [opt]: number — Slot interval reflects the amount of time the between bookin
  - `slotIntervalUnit` [opt]: string — Unit for slot interval.
  - `slotBuffer` [opt]: number — Slot-Buffer is additional time that can be added after an ap
  - `slotBufferUnit` [opt]: string — Unit for slot buffer.
  - `preBuffer` [opt]: number — Pre-Buffer is additional time that can be added before an ap
  - `preBufferUnit` [opt]: string — Unit for pre-buffer.
  - `appoinmentPerSlot` [opt]: number — Maximum bookings per slot (per user). Maximum seats per slot
  - `appoinmentPerDay` [opt]: number — Number of appointments that can be booked for a given day
  - `allowBookingAfter` [opt]: number — Minimum scheduling notice for events
  - `allowBookingAfterUnit` [opt]: string e.g. `'days'` — Unit for minimum scheduling notice
  - `allowBookingFor` [opt]: number — Minimum number of days/weeks/months for which to allow booki
  - `allowBookingForUnit` [opt]: string e.g. `'days'` — Unit for controlling the duration for which booking would be
  - `openHours` [opt]: array — This is only to set the standard availability. For custom av
  - `enableRecurring` [opt]: boolean — Enable recurring appointments for the calendars. Please note
  - `recurring` [opt]: Recurring
  - `formId` [opt]: string
  - `stickyContact` [opt]: boolean
  - `isLivePaymentMode` [opt]: boolean
  - `autoConfirm` [opt]: boolean
  - `shouldSendAlertEmailsToAssignedMember` [opt]: boolean
  - `alertEmail` [opt]: string
  - `googleInvitationEmails` [opt]: boolean
  - `allowReschedule` [opt]: boolean
  - `allowCancellation` [opt]: boolean
  - `shouldAssignContactToTeamMember` [opt]: boolean
  - `shouldSkipAssigningContactForExisting` [opt]: boolean
  - `notes` [opt]: string
  - `pixelId` [opt]: string
  - `formSubmitType` [opt]: string
  - `formSubmitRedirectURL` [opt]: string
  - `formSubmitThanksMessage` [opt]: string
  - `availabilityType` [opt]: number — Determines which availability type to consider:
- **1**: Onl
  - `availabilities` [opt]: array — This is only to set the custom availability. For standard av
  - `guestType` [opt]: string
  - `consentLabel` [opt]: string
  - `calendarCoverImage` [opt]: string e.g. `'https://path-to-image.com'`
  - `lookBusyConfig` [opt]:  — Look Busy Configuration

### GET `/calendars/appointments/{appointmentId}/notes` — Get Notes

**Query params:**

  - `limit` [REQ]: number — Limit of notes to fetch
  - `offset` [REQ]: number — Offset of notes to fetch

### POST `/calendars/appointments/{appointmentId}/notes` — Create Note

**Body** (application/json):

  - `userId` [opt]: string e.g. `'GCs5KuzPqTls7vWclkEV'`
  - `body` [REQ]: string e.g. `'lorem ipsum'` — Note body

### PUT `/calendars/appointments/{appointmentId}/notes/{noteId}` — Update Note

**Body** (application/json):

  - `userId` [opt]: string e.g. `'GCs5KuzPqTls7vWclkEV'`
  - `body` [REQ]: string e.g. `'lorem ipsum'` — Note body

### DELETE `/calendars/appointments/{appointmentId}/notes/{noteId}` — Delete Note

### GET `/calendars/blocked-slots` — Get Blocked Slots

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `userId` [opt]: string — User Id - Owner of an appointment. Either of userId, groupId
  - `calendarId` [opt]: string — Either of calendarId, userId or groupId is required
  - `groupId` [opt]: string — Either of groupId, calendarId or userId is required
  - `startTime` [REQ]: string — Start Time (in millis)
  - `endTime` [REQ]: string — End Time (in millis)

### GET `/calendars/events` — Get Calendar Events

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `userId` [opt]: string — User Id - Owner of an appointment. Either of userId, groupId
  - `calendarId` [opt]: string — Either of calendarId, userId or groupId is required
  - `groupId` [opt]: string — Either of groupId, calendarId or userId is required
  - `startTime` [REQ]: string — Start Time (in millis)
  - `endTime` [REQ]: string — End Time (in millis)

### POST `/calendars/events/appointments` — Create appointment

**Body** (application/json):

  - `title` [opt]: string e.g. `'Test Event'` — Title
  - `meetingLocationType` [opt]: string e.g. `'custom'` — Meeting location type. 
- If `address` is provided in the re
  - `meetingLocationId` [opt]: string e.g. `'custom_0'` — The unique identifier for the meeting location.
- This value
  - `overrideLocationConfig` [opt]: boolean e.g. `True` — Flag to override location config
- **false** - If only `meet
  - `appointmentStatus` [opt]: string e.g. `'confirmed'`
  - `assignedUserId` [opt]: string e.g. `'0007BWpSzSwfiuSl0tR2'` — Assigned User Id
  - `description` [opt]: string e.g. `'Booking a call to discuss the project'` — Appointment Description
  - `address` [opt]: string e.g. `'Zoom'` — Appointment Address
  - `ignoreDateRange` [opt]: boolean e.g. `False` — If set to true, the minimum scheduling notice and date range
  - `toNotify` [opt]: boolean e.g. `False` — If set to false, the automations will not run
  - `ignoreFreeSlotValidation` [opt]: boolean e.g. `True` — If true the time slot validation would be avoided for any ap
  - `rrule` [opt]: string — RRULE as per the iCalendar (RFC 5545) specification for recu
  - `calendarId` [REQ]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Calendar Id
  - `locationId` [REQ]: string e.g. `'C2QujeCh8ZnC7al2InWR'` — Location Id
  - `contactId` [REQ]: string e.g. `'0007BWpSzSwfiuSl0tR2'` — Contact Id
  - `startTime` [REQ]: string e.g. `'2021-06-23T03:30:00+05:30'` — Start Time
  - `endTime` [opt]: string e.g. `'2021-06-23T04:30:00+05:30'` — End Time

### PUT `/calendars/events/appointments/{eventId}` — Update Appointment

**Body** (application/json):

  - `title` [opt]: string e.g. `'Test Event'` — Title
  - `meetingLocationType` [opt]: string e.g. `'custom'` — Meeting location type. 
- If `address` is provided in the re
  - `meetingLocationId` [opt]: string e.g. `'custom_0'` — The unique identifier for the meeting location.
- This value
  - `overrideLocationConfig` [opt]: boolean e.g. `True` — Flag to override location config
- **false** - If only `meet
  - `appointmentStatus` [opt]: string e.g. `'confirmed'`
  - `assignedUserId` [opt]: string e.g. `'0007BWpSzSwfiuSl0tR2'` — Assigned User Id
  - `description` [opt]: string e.g. `'Booking a call to discuss the project'` — Appointment Description
  - `address` [opt]: string e.g. `'Zoom'` — Appointment Address
  - `ignoreDateRange` [opt]: boolean e.g. `False` — If set to true, the minimum scheduling notice and date range
  - `toNotify` [opt]: boolean e.g. `False` — If set to false, the automations will not run
  - `ignoreFreeSlotValidation` [opt]: boolean e.g. `True` — If true the time slot validation would be avoided for any ap
  - `rrule` [opt]: string — RRULE as per the iCalendar (RFC 5545) specification for recu
  - `calendarId` [opt]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Calendar Id
  - `startTime` [opt]: string e.g. `'2021-06-23T03:30:00+05:30'` — Start Time
  - `endTime` [opt]: string e.g. `'2021-06-23T04:30:00+05:30'` — End Time

### GET `/calendars/events/appointments/{eventId}` — Get Appointment

### POST `/calendars/events/block-slots` — Create Block Slot

**Body** (application/json):

  - `title` [opt]: string e.g. `'Test Event'` — Title
  - `calendarId` [REQ]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Either calendarId or assignedUserId can be set, not both.
  - `assignedUserId` [opt]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Either calendarId or assignedUserId can be set, not both.
  - `locationId` [REQ]: string e.g. `'C2QujeCh8ZnC7al2InWR'` — Location Id
  - `startTime` [opt]: string e.g. `'2021-06-23T03:30:00+05:30'` — Start Time
  - `endTime` [opt]: string e.g. `'2021-06-23T04:30:00+05:30'` — End Time

### PUT `/calendars/events/block-slots/{eventId}` — Update Block Slot

**Body** (application/json):

  - `title` [opt]: string e.g. `'Test Event'` — Title
  - `calendarId` [REQ]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Either calendarId or assignedUserId can be set, not both.
  - `assignedUserId` [opt]: string e.g. `'CVokAlI8fgw4WYWoCtQz'` — Either calendarId or assignedUserId can be set, not both.
  - `locationId` [REQ]: string e.g. `'C2QujeCh8ZnC7al2InWR'` — Location Id
  - `startTime` [opt]: string e.g. `'2021-06-23T03:30:00+05:30'` — Start Time
  - `endTime` [opt]: string e.g. `'2021-06-23T04:30:00+05:30'` — End Time

### DELETE `/calendars/events/{eventId}` — Delete Event

**Body** (application/json):

  (schema vazio no spec oficial)

### GET `/calendars/groups` — Get Groups

**Query params:**

  - `locationId` [REQ]: string — Location Id

### POST `/calendars/groups` — Create Calendar Group

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'ocQHyuzHvysMo5N5VsXc'`
  - `name` [REQ]: string e.g. `'group a'`
  - `description` [REQ]: string e.g. `'group description'`
  - `slug` [REQ]: string e.g. `'15-mins'`
  - `isActive` [opt]: boolean e.g. `True`

### POST `/calendars/groups/validate-slug` — Validate group slug

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id
  - `slug` [REQ]: string e.g. `'calendar-1'` — Slug

### DELETE `/calendars/groups/{groupId}` — Delete Group

### PUT `/calendars/groups/{groupId}` — Update Group

**Body** (application/json):

  - `name` [REQ]: string e.g. `'group a'`
  - `description` [REQ]: string e.g. `'group description'`
  - `slug` [REQ]: string e.g. `'15-mins'`

### PUT `/calendars/groups/{groupId}/status` — Disable Group

**Body** (application/json):

  - `isActive` [REQ]: boolean e.g. `True` — Is Active?

### GET `/calendars/resources/{resourceType}` — List Calendar Resources

**Query params:**

  - `locationId` [REQ]: string
  - `limit` [REQ]: number
  - `skip` [REQ]: number

### POST `/calendars/resources/{resourceType}` — Create Calendar Resource

**Body** (application/json):

  - `locationId` [REQ]: string
  - `name` [REQ]: string
  - `description` [REQ]: string
  - `quantity` [REQ]: number — Quantity of the equipment.
  - `outOfService` [REQ]: number — Quantity of the out of service equipment.
  - `capacity` [REQ]: number — Capacity of the room.
  - `calendarIds` [REQ]: array — Service calendar IDs to be mapped with the resource.

    On

### GET `/calendars/resources/{resourceType}/{id}` — Get Calendar Resource

### PUT `/calendars/resources/{resourceType}/{id}` — Update Calendar Resource

**Body** (application/json):

  - `locationId` [opt]: string
  - `name` [opt]: string
  - `description` [opt]: string
  - `quantity` [opt]: number — Quantity of the equipment.
  - `outOfService` [opt]: number — Quantity of the out of service equipment.
  - `capacity` [opt]: number — Capacity of the room.
  - `calendarIds` [opt]: array — Service calendar IDs to be mapped with the resource.

    On
  - `isActive` [opt]: boolean

### DELETE `/calendars/resources/{resourceType}/{id}` — Delete Calendar Resource

### PUT `/calendars/{calendarId}` — Update Calendar

**Body** (application/json):

  - `notifications` [opt]: array — 🚨 Deprecated! Please use 'Calendar Notifications APIs' inste
  - `groupId` [opt]: string e.g. `'BqTwX8QFwXzpegMve9EQ'` — Group Id
  - `teamMembers` [opt]: array — Team members are required for calendars of type: Round Robin
  - `eventType` [opt]: string
  - `name` [opt]: string e.g. `'test calendar'`
  - `description` [opt]: string e.g. `'this is used for testing'`
  - `slug` [opt]: string e.g. `'test1'`
  - `widgetSlug` [opt]: string e.g. `'test1'`
  - `widgetType` [opt]: string e.g. `'classic'` — Calendar widget type. Choose "default" for "neo" and "classi
  - `eventTitle` [opt]: string
  - `eventColor` [opt]: string
  - `locationConfigurations` [opt]: array — Meeting location configuration for event calendar
  - `meetingLocation` [opt]: string — 🚨 Deprecated! Use `locationConfigurations.location` or `team
  - `slotDuration` [opt]: number — This controls the duration of the meeting
  - `slotDurationUnit` [opt]: string — Unit for slot duration.
  - `preBufferUnit` [opt]: string — Unit for pre-buffer.
  - `slotInterval` [opt]: number — Slot interval reflects the amount of time the between bookin
  - `slotIntervalUnit` [opt]: string — Unit for slot interval.
  - `slotBuffer` [opt]: number — Slot-Buffer is additional time that can be added after an ap
  - `preBuffer` [opt]: number — Pre-Buffer is additional time that can be added before an ap
  - `appoinmentPerSlot` [opt]: number
  - `appoinmentPerDay` [opt]: number — Number of appointments that can be booked for a given day
  - `allowBookingAfter` [opt]: number — Minimum scheduling notice for events
  - `allowBookingAfterUnit` [opt]: string e.g. `'days'` — Unit for minimum scheduling notice
  - `allowBookingFor` [opt]: number — Minimum number of days/weeks/months for which to allow booki
  - `allowBookingForUnit` [opt]: string e.g. `'days'` — Unit for controlling the duration for which booking would be
  - `openHours` [opt]: array
  - `enableRecurring` [opt]: boolean — Enable recurring appointments for the calendars. Please note
  - `recurring` [opt]: Recurring
  - `formId` [opt]: string
  - `stickyContact` [opt]: boolean
  - `isLivePaymentMode` [opt]: boolean
  - `autoConfirm` [opt]: boolean
  - `shouldSendAlertEmailsToAssignedMember` [opt]: boolean
  - `alertEmail` [opt]: string
  - `googleInvitationEmails` [opt]: boolean
  - `allowReschedule` [opt]: boolean
  - `allowCancellation` [opt]: boolean
  - `shouldAssignContactToTeamMember` [opt]: boolean
  - `shouldSkipAssigningContactForExisting` [opt]: boolean
  - `notes` [opt]: string
  - `pixelId` [opt]: string
  - `formSubmitType` [opt]: string
  - `formSubmitRedirectURL` [opt]: string
  - `formSubmitThanksMessage` [opt]: string
  - `availabilityType` [opt]: number — Determines which availability type to consider:
- **1**: Onl
  - `availabilities` [opt]: array — This is only to set the custom availability. For standard av
  - `guestType` [opt]: string
  - `consentLabel` [opt]: string
  - `calendarCoverImage` [opt]: string
  - `lookBusyConfig` [opt]:  — Look Busy Configuration
  - `isActive` [opt]: boolean

### GET `/calendars/{calendarId}` — Get Calendar

### DELETE `/calendars/{calendarId}` — Delete Calendar

### GET `/calendars/{calendarId}/free-slots` — Get Free Slots

**Query params:**

  - `startDate` [REQ]: number — Start Date (**⚠️ Important:** Date range cannot be more than
  - `endDate` [REQ]: number — End Date (**⚠️ Important:** Date range cannot be more than 3
  - `timezone` [opt]: string — The timezone in which the free slots are returned
  - `userId` [opt]: string — The user for whom the free slots are returned
  - `userIds` [opt]: array — The users for whom the free slots are returned

### GET `/calendars/{calendarId}/notifications` — Get notifications

**Query params:**

  - `isActive` [opt]: boolean
  - `deleted` [opt]: boolean
  - `limit` [opt]: number — Number of records to return
  - `skip` [opt]: number — Number of records to skip

### POST `/calendars/{calendarId}/notifications` — Create notification

**Body** (application/json):

array of:
  - `receiverType` [REQ]: string — notification recipient type
  - `channel` [REQ]: string — Notification channel
  - `notificationType` [REQ]: string — Notification type
  - `isActive` [opt]: boolean — Is the notification active
  - `templateId` [opt]: string — Template ID for email notification. Not necessary for in-App
  - `body` [opt]: string — Body  for email notification. Not necessary for in-App notif
  - `subject` [opt]: string — Subject  for email notification. Not necessary for in-App no
  - `afterTime` [opt]: array e.g. `[{'timeOffset': 1, 'unit': 'hours'}]` — Specifies the time after which the follow-up notification sh
  - `beforeTime` [opt]: array e.g. `[{'timeOffset': 1, 'unit': 'hours'}]` — Specifies the time before which the reminder notification sh
  - `additionalEmailIds` [opt]: array e.g. `['example1@email.com', 'example2@email.com']` — Additional email addresses to receive notifications.
  - `additionalPhoneNumbers` [opt]: array e.g. `['+919876744444', '+919876744445']` — Additional phone numbers to receive notifications.
  - `selectedUsers` [opt]: array — selected user for in-App notification
  - `fromAddress` [opt]: string — from address for email notification
  - `fromName` [opt]: string — from name for email/sms notification
  - `fromNumber` [opt]: string — from number for sms notification

### GET `/calendars/{calendarId}/notifications/{notificationId}` — Get notification

### PUT `/calendars/{calendarId}/notifications/{notificationId}` — Update notification

**Body** (application/json):

  - `receiverType` [opt]: string — Notification recipient type
  - `additionalEmailIds` [opt]: array e.g. `['example1@email.com', 'example2@email.com']` — Additional email addresses to receive notifications.
  - `additionalPhoneNumbers` [opt]: array e.g. `['+919876744444', '+919876744445']` — Additional phone numbers to receive notifications.
  - `selectedUsers` [opt]: array — selected user for in-App notification
  - `channel` [opt]: string — Notification channel
  - `notificationType` [opt]: string — Notification type
  - `isActive` [opt]: boolean — Is the notification active
  - `deleted` [opt]: boolean — Marks the notification as deleted (soft delete)
  - `templateId` [opt]: string — Template ID for email notification
  - `body` [opt]: string — Body  for email notification. Not necessary for in-App notif
  - `subject` [opt]: string — Subject  for email notification. Not necessary for in-App no
  - `afterTime` [opt]: array e.g. `[{'timeOffset': 1, 'unit': 'hours'}]` — Specifies the time after which the follow-up notification sh
  - `beforeTime` [opt]: array e.g. `[{'timeOffset': 1, 'unit': 'hours'}]` — Specifies the time before which the reminder notification sh
  - `fromAddress` [opt]: string — From address for email notification
  - `fromNumber` [opt]: string — from number for sms notification
  - `fromName` [opt]: string — From name for email/sms notification

### DELETE `/calendars/{calendarId}/notifications/{notificationId}` — Delete Notification

## Conversations & Messages


### POST `/conversations/` — Create Conversation

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'tDtDnQdgm2LXpyiqYvZ6'` — Location ID as string
  - `contactId` [REQ]: string e.g. `'tDtDnQdgm2LXpyiqYvZ6'` — Contact ID as string

### GET `/conversations/locations/{locationId}/messages/{messageId}/transcription` — Get transcription by Message ID

### GET `/conversations/locations/{locationId}/messages/{messageId}/transcription/download` — Download transcription by Message ID

### POST `/conversations/messages` — Send a new message

**Body** (application/json):

  - `type` [REQ]: string e.g. `'Email'` — Type of message being sent
  - `contactId` [REQ]: string e.g. `'abc123def456'` — ID of the contact receiving the message
  - `appointmentId` [opt]: string e.g. `'appt123'` — ID of the associated appointment
  - `attachments` [opt]: array e.g. `['https://storage.com/file1.pdf', 'https://storage` — Array of attachment URLs
  - `emailFrom` [opt]: string e.g. `'sender@company.com'` — Email address to send from
  - `emailCc` [opt]: array e.g. `['cc1@company.com', 'cc2@company.com']` — Array of CC email addresses
  - `emailBcc` [opt]: array e.g. `['bcc1@company.com', 'bcc2@company.com']` — Array of BCC email addresses
  - `html` [opt]: string e.g. `'<p>Hello World</p>'` — HTML content of the message
  - `message` [opt]: string e.g. `'Hello, how can I help you today?'` — Text content of the message
  - `subject` [opt]: string e.g. `'Important Update'` — Subject line for email messages
  - `replyMessageId` [opt]: string e.g. `'msg123'` — ID of message being replied to
  - `templateId` [opt]: string e.g. `'template123'` — ID of message template
  - `threadId` [opt]: string e.g. `'thread123'` — ID of message thread. For email messages, this is the messag
  - `scheduledTimestamp` [opt]: number e.g. `1669287863` — UTC Timestamp (in seconds) at which the message should be sc
  - `conversationProviderId` [opt]: string e.g. `'provider123'` — ID of conversation provider
  - `emailTo` [opt]: string e.g. `'recipient@company.com'` — Email address to send to, if different from contact's primar
  - `emailReplyMode` [opt]: string e.g. `'reply_all'` — Mode for email replies
  - `fromNumber` [opt]: string e.g. `'+1499499299'` — Phone number used as the sender number for outbound messages
  - `toNumber` [opt]: string e.g. `'+1439499299'` — Recipient phone number for outbound messages

### DELETE `/conversations/messages/email/{emailMessageId}/schedule` — Cancel a scheduled email message.

### GET `/conversations/messages/email/{id}` — Get email by Id

### POST `/conversations/messages/inbound` — Add an inbound message

**Body** (application/json):

  - `type` [REQ]: string e.g. `'SMS'` — Message Type
  - `attachments` [opt]: array — Array of attachments
  - `message` [opt]: string — Message Body
  - `conversationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Conversation Id
  - `conversationProviderId` [REQ]: string e.g. `'61d6d1f9cdac7612faf80753'` — Conversation Provider Id
  - `html` [opt]: string — HTML Body of Email
  - `subject` [opt]: string — Subject of the Email
  - `emailFrom` [opt]: string e.g. `'sender@company.com'` — Email address to send from. This field is associated with th
  - `emailTo` [opt]: string — Recipient email address. This field is associated with the c
  - `emailCc` [opt]: array e.g. `['john1@doe.com', 'john2@doe.com']` — List of email address to CC
  - `emailBcc` [opt]: array e.g. `['john1@doe.com', 'john2@doe.com']` — List of email address to BCC
  - `emailMessageId` [opt]: string — Send the email message id for which this email should be thr
  - `altId` [opt]: string e.g. `'61d6d1f9cdac7612faf80753'` — external mail provider's message id
  - `direction` [opt]: object e.g. `['outbound', 'inbound']` — Message direction, if required can be set manually, default 
  - `date` [opt]: string (date-time) — Date of the inbound message
  - `call` [opt]:  — Phone call dialer and receiver information

### POST `/conversations/messages/outbound` — Add an external outbound call

**Body** (application/json):

  - `type` [REQ]: string e.g. `'Call'` — Message Type
  - `attachments` [opt]: array — Array of attachments
  - `conversationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Conversation Id
  - `conversationProviderId` [REQ]: string e.g. `'61d6d1f9cdac7612faf80753'` — Conversation Provider Id
  - `altId` [opt]: string e.g. `'61d6d1f9cdac7612faf80753'` — external mail provider's message id
  - `date` [opt]: string (date-time) — Date of the outbound message
  - `call` [opt]:  — Phone call dialer and receiver information

### POST `/conversations/messages/upload` — Upload file attachments

**Body** (multipart/form-data):

  - `conversationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Conversation Id
  - `locationId` [REQ]: string
  - `attachmentUrls` [REQ]: array

### GET `/conversations/messages/{id}` — Get message by message id

### GET `/conversations/messages/{messageId}/locations/{locationId}/recording` — Get Recording by Message ID

### DELETE `/conversations/messages/{messageId}/schedule` — Cancel a scheduled message.

### PUT `/conversations/messages/{messageId}/status` — Update message status

**Body** (application/json):

  - `status` [REQ]: string e.g. `'read'` — Message status
  - `error` [opt]:  — Error object from the conversation provider
  - `emailMessageId` [opt]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Email message Id
  - `recipients` [opt]: array — Email delivery status for additional email recipients.

### POST `/conversations/providers/live-chat/typing` — Agent/Ai-Bot is typing a message indicator for live chat

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id
  - `isTyping` [REQ]: string e.g. `True` — Typing status
  - `visitorId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — visitorId is the Unique ID assigned to each Live chat visito
  - `conversationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Conversation Id

### GET `/conversations/search` — Search Conversations

**Query params:**

  - `locationId` [REQ]: string — Location Id
  - `contactId` [opt]: string — Contact Id
  - `assignedTo` [opt]: string — User IDs that conversations are assigned to. Multiple IDs ca
  - `followers` [opt]: string — User IDs of followers to filter conversations by. Multiple I
  - `mentions` [opt]: string — User Id of the mention. Multiple values are comma separated.
  - `query` [opt]: string — Search paramater as a string
  - `sort` [opt]: string — Sort paramater - asc or desc
  - `startAfterDate` [opt]: any — Search to begin after the specified date - should contain th
  - `id` [opt]: string — Id of the conversation
  - `limit` [opt]: number — Limit of conversations - Default is 20
  - `lastMessageType` [opt]: string — Type of the last message in the conversation as a string
  - `lastMessageAction` [opt]: string — Action of the last outbound message in the conversation as s
  - `lastMessageDirection` [opt]: string — Direction of the last message in the conversation as string.
  - `status` [opt]: string — The status of the conversation to be filtered - all, read, u
  - `sortBy` [opt]: string — The sorting of the conversation to be filtered as - manual m
  - `sortScoreProfile` [opt]: string — Id of score profile on which sortBy.ScoreProfile should sort
  - `scoreProfile` [opt]: string — Id of score profile on which conversations should get filter
  - `scoreProfileMin` [opt]: number — Minimum value for score
  - `scoreProfileMax` [opt]: number — Maximum value for score

### GET `/conversations/{conversationId}` — Get Conversation

### PUT `/conversations/{conversationId}` — Update Conversation

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'tDtDnQdgm2LXpyiqYvZ6'` — Location ID as string
  - `unreadCount` [opt]: number e.g. `1` — Count of unread messages in the conversation
  - `starred` [opt]: boolean e.g. `True` — Starred status of the conversation.
  - `feedback` [opt]: object

### DELETE `/conversations/{conversationId}` — Delete Conversation

### GET `/conversations/{conversationId}/messages` — Get messages by conversation id

**Query params:**

  - `lastMessageId` [opt]: string — Message ID of the last message in the list as a string
  - `limit` [opt]: number — Number of messages to be fetched from the conversation. Defa
  - `type` [opt]: string — Types of message to fetched separated with comma

## Users


### GET `/users/` — Get User by Location

**Query params:**

  - `locationId` [REQ]: string

### POST `/users/` — Create User

**Body** (application/json):

  - `companyId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'`
  - `firstName` [REQ]: string e.g. `'John'`
  - `lastName` [REQ]: string e.g. `'Deo'`
  - `email` [REQ]: string e.g. `'john@deo.com'`
  - `password` [REQ]: string e.g. `'*******'`
  - `phone` [opt]: string e.g. `'+18832327657'`
  - `type` [REQ]: string e.g. `'account'`
  - `role` [REQ]: string e.g. `'admin'`
  - `locationIds` [REQ]: array e.g. `['C2QujeCh8ZnC7al2InWR']`
  - `permissions` [opt]: PermissionsDto
  - `scopes` [opt]: array e.g. `['contacts.write', 'campaigns.readonly']` — Scopes allowed for users. Only scopes that have been passed 
  - `scopesAssignedToOnly` [opt]: array e.g. `['contacts.write', 'campaigns.readonly']` — Assigned Scopes allowed for users. Only scopes that have bee
  - `profilePhoto` [opt]: string e.g. `'https://img.png'`

### GET `/users/search` — Search Users

**Query params:**

  - `companyId` [REQ]: string — Company ID in which the search needs to be performed
  - `query` [opt]: string — The search term for the user is matched based on the user fu
  - `skip` [opt]: string — No of results to be skipped before returning the result
  - `limit` [opt]: string — No of results to be limited before returning the result
  - `locationId` [opt]: string — Location ID in which the search needs to be performed
  - `type` [opt]: string — Type of the users to be filtered in the search
  - `role` [opt]: string — Role of the users to be filtered in the search
  - `ids` [opt]: string — List of User IDs to be filtered in the search
  - `sort` [opt]: string — The field on which sort is applied in which the results need
  - `sortDirection` [opt]: string — The direction in which the results need to be sorted
  - `enabled2waySync` [opt]: boolean

### POST `/users/search/filter-by-email` — Filter Users by Email

**Body** (application/json):

  - `companyId` [REQ]: string e.g. `'5DP41231LkQsiKESj6rh'` — Company ID to filter users
  - `emails` [REQ]: array e.g. `['user1@example.com', 'user2@example.com']` — Array of email addresses to filter users
  - `deleted` [opt]: boolean e.g. `False` — Filter deleted users
  - `skip` [opt]: string e.g. `'1'` — No of results to be skipped before returning the result
  - `limit` [opt]: string e.g. `'10'` — No of results to be limited before returning the result
  - `projection` [opt]: string e.g. `'all'` — Projection fields to return. Use "all" for all fields, or sp

### GET `/users/{userId}` — Get User

### PUT `/users/{userId}` — Update User

**Body** (application/json):

  - `firstName` [opt]: string e.g. `'John'`
  - `lastName` [opt]: string e.g. `'Deo'`
  - `email` [opt]: string e.g. `'john@deo.com'` — Email update is no longer supported due to security reasons.
  - `emailChangeOTP` [opt]: string e.g. `'191344'` — OTP to change the email ID of the user
  - `password` [opt]: string e.g. `'*******'`
  - `phone` [opt]: string e.g. `'+18832327657'`
  - `type` [opt]: string e.g. `'account'`
  - `role` [opt]: string e.g. `'admin'`
  - `companyId` [opt]: string e.g. `'UAXssdawIWAWD'` — Company/Agency Id. Required for Agency Level access
  - `locationIds` [opt]: array e.g. `['C2QujeCh8ZnC7al2InWR']`
  - `permissions` [opt]: PermissionsDto
  - `scopes` [opt]: array e.g. `['contacts.write', 'campaigns.readonly']` — Scopes allowed for users. Only scopes that have been passed 
  - `scopesAssignedToOnly` [opt]: array e.g. `['contacts.write', 'campaigns.readonly']` — Assigned Scopes allowed for users. Only scopes that have bee
  - `profilePhoto` [opt]: string e.g. `'https://img.png'`

### DELETE `/users/{userId}` — Delete User

## Opportunities


### POST `/opportunities/` — Create Opportunity

**Body** (application/json):

  - `pipelineId` [REQ]: string e.g. `'VDm7RPYC2GLUvdpKmBfC'` — pipeline Id
  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'`
  - `name` [REQ]: string e.g. `'First Opps'`
  - `pipelineStageId` [opt]: string e.g. `'7915dedc-8f18-44d5-8bc3-77c04e994a10'`
  - `status` [REQ]: string
  - `contactId` [REQ]: string e.g. `'mTkSCb1UBjb5tk4OvB69'`
  - `monetaryValue` [opt]: number e.g. `220`
  - `assignedTo` [opt]: string e.g. `'082goXVW3lIExEQPOnd3'`
  - `customFields` [opt]: array — Add custom fields to opportunities.

### GET `/opportunities/pipelines` — Get Pipelines

**Query params:**

  - `locationId` [REQ]: string e.g. `ve9EPM428h8vShlRW1KT`

### GET `/opportunities/search` — Search Opportunity

**Query params:**

  - `q` [opt]: string
  - `location_id` [REQ]: string — Location Id
  - `pipeline_id` [opt]: string — Pipeline Id
  - `pipeline_stage_id` [opt]: string — stage Id
  - `contact_id` [opt]: string — Contact Id
  - `status` [opt]: string
  - `assigned_to` [opt]: string
  - `campaignId` [opt]: string — Campaign Id
  - `id` [opt]: string — Opportunity Id
  - `order` [opt]: string
  - `endDate` [opt]: string — End date
  - `startAfter` [opt]: string — Start After
  - `startAfterId` [opt]: string — Start After Id
  - `date` [opt]: string — Start date
  - `country` [opt]: string
  - `page` [opt]: number
  - `limit` [opt]: number — Limit Per Page records count. will allow maximum up to 100 a
  - `getTasks` [opt]: boolean — get Tasks in contact
  - `getNotes` [opt]: boolean — get Notes in contact
  - `getCalendarEvents` [opt]: boolean — get Calender event in contact

### POST `/opportunities/upsert` — Upsert Opportunity

**Body** (application/json):

  - `pipelineId` [REQ]: string e.g. `'bCkKGpDsyPP4peuKowkG'` — pipeline Id
  - `locationId` [REQ]: string e.g. `'CLu7BaljjqrEjBGKTNNe'` — locationId
  - `contactId` [REQ]: string e.g. `'LiKJ2vnRg5ETM8Z19K7'` — contactId
  - `name` [opt]: string e.g. `'opportunity name'` — name
  - `status` [opt]: string
  - `pipelineStageId` [opt]: string e.g. `'7915dedc-8f18-44d5-8bc3-77c04e994a10'`
  - `monetaryValue` [opt]: number e.g. `220`
  - `assignedTo` [opt]: string e.g. `'082goXVW3lIExEQPOnd3'`

### GET `/opportunities/{id}` — Get Opportunity

### DELETE `/opportunities/{id}` — Delete Opportunity

### PUT `/opportunities/{id}` — Update Opportunity

**Body** (application/json):

  - `pipelineId` [opt]: string e.g. `'bCkKGpDsyPP4peuKowkG'` — pipeline Id
  - `name` [opt]: string e.g. `'First Opps'`
  - `pipelineStageId` [opt]: string e.g. `'7915dedc-8f18-44d5-8bc3-77c04e994a10'`
  - `status` [opt]: string
  - `monetaryValue` [opt]: number e.g. `220`
  - `assignedTo` [opt]: string e.g. `'082goXVW3lIExEQPOnd3'`
  - `customFields` [opt]: array — Update custom fields to opportunities.

### POST `/opportunities/{id}/followers` — Add Followers

**Body** (application/json):

  - `followers` [REQ]: array e.g. `['sx6wyHhbFdRXh302Lunr', 'sx6wyHhbFdRXh302Lunr']`

### DELETE `/opportunities/{id}/followers` — Remove Followers

**Body** (application/json):

  - `followers` [REQ]: array e.g. `['sx6wyHhbFdRXh302Lunr', 'sx6wyHhbFdRXh302Lunr']`

### PUT `/opportunities/{id}/status` — Update Opportunity Status

**Body** (application/json):

  - `status` [REQ]: string

## Custom Fields


### POST `/custom-fields/` — Create Custom Field

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id
  - `name` [opt]: string e.g. `'Name'` — Field name
  - `description` [opt]: string — Description of the field
  - `placeholder` [opt]: string — Placeholder text for the field
  - `showInForms` [REQ]: boolean — Whether the field should be shown in forms
  - `options` [opt]: array — Options for the field (Optional, valid only for SINGLE_OPTIO
  - `acceptedFormats` [opt]: string — Allowed file formats for uploads. Options include: .pdf, .do
  - `dataType` [REQ]: string — Type of field that you are trying to create
  - `fieldKey` [REQ]: string e.g. `'custom_object.pet.name'` — Field key. For Custom Object it's formatted as "custom_objec
  - `objectKey` [REQ]: string e.g. `'custom_object.pet'` — The key for your custom object. This key uniquely identifies
  - `maxFileLimit` [opt]: number e.g. `2` — Maximum file limit for uploads. Applicable only for fields w
  - `allowCustomOption` [opt]: boolean e.g. `True` — Determines if users can add a custom option value different 
  - `parentId` [REQ]: string — ID of the parent folder

### POST `/custom-fields/folder` — Create Custom Field Folder

**Body** (application/json):

  - `objectKey` [REQ]: string e.g. `'custom_object.pet'` — The key for your custom object. This key uniquely identifies
  - `name` [REQ]: string e.g. `'Name'` — Field name
  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id

### PUT `/custom-fields/folder/{id}` — Update Custom Field Folder Name

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Name'` — Field name
  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id

### DELETE `/custom-fields/folder/{id}` — Delete Custom Field Folder

**Query params:**

  - `locationId` [REQ]: string — Location Id

### GET `/custom-fields/object-key/{objectKey}` — Get Custom Fields By Object Key

**Query params:**

  - `locationId` [REQ]: string e.g. `Location Id`

### GET `/custom-fields/{id}` — Get Custom Field / Folder By Id

### PUT `/custom-fields/{id}` — Update Custom Field By Id

**Body** (application/json):

  - `locationId` [REQ]: string e.g. `'ve9EPM428h8vShlRW1KT'` — Location Id
  - `name` [opt]: string e.g. `'Name'` — Field name
  - `description` [opt]: string — Description of the field
  - `placeholder` [opt]: string — Placeholder text for the field
  - `showInForms` [REQ]: boolean — Whether the field should be shown in forms
  - `options` [opt]: array — Options for the field. Important: Providing options will com
  - `acceptedFormats` [opt]: string — Allowed file formats for uploads. Options include: .pdf, .do
  - `maxFileLimit` [opt]: number e.g. `2` — Maximum file limit for uploads. Applicable only for fields w

### DELETE `/custom-fields/{id}` — Delete Custom Field By Id

## Locations


### POST `/locations/` — Create Sub-Account (Formerly Location)

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Mark Shoes'` — The name for the sub-account/location
  - `phone` [opt]: string e.g. `'+1410039940'` — The phone number of the business for which sub-account is cr
  - `companyId` [REQ]: string e.g. `'UAXssdawIWAWD'` — Company/Agency Id
  - `address` [opt]: string e.g. `'4th fleet street'` — The address of the business for which sub-account is created
  - `city` [opt]: string e.g. `'New York'` — The city where the business is located for which sub-account
  - `state` [opt]: string e.g. `'Illinois'` — The state in which the business operates for which sub-accou
  - `country` [opt]: string e.g. `'US'` — The 2 letter country-code in which the business is present f
  - `postalCode` [opt]: string e.g. `'567654'` — The postal code of the business for which sub-account is cre
  - `website` [opt]: string e.g. `'https://yourwebsite.com'` — The website of the business for which sub-account is created
  - `timezone` [opt]: string e.g. `'US/Central'` — The timezone of the business for which sub-account is create
  - `prospectInfo` [opt]:  e.g. `{'firstName': 'John', 'lastName': 'Doe', 'email': `
  - `settings` [opt]:  — The default settings for location
  - `social` [opt]:  — The social media links for location
  - `twilio` [opt]:  — The twilio credentials for location
  - `mailgun` [opt]:  — The mailgun credentials for location
  - `snapshotId` [opt]: string e.g. `'XXXXXXXXXXX'` — The snapshot ID to be loaded into the location.

### GET `/locations/search` — Search

**Query params:**

  - `companyId` [opt]: string e.g. `5DP4iH6HLkQsiKESj6rh` — The company/agency id on which you want to perform the searc
  - `skip` [opt]: string e.g. `1` — The value by which the results should be skipped. Default wi
  - `limit` [opt]: string e.g. `10` — The value by which the results should be limited. Default wi
  - `order` [opt]: string e.g. `asc` — The order in which the results should be returned - Allowed 
  - `email` [opt]: string e.g. `johndoe@mail.com`

### GET `/locations/{locationId}` — Get Sub-Account (Formerly Location)

### PUT `/locations/{locationId}` — Put Sub-Account (Formerly Location)

**Body** (application/json):

  - `name` [opt]: string e.g. `'Mark Shoes'` — The name for the sub-account/location
  - `phone` [opt]: string e.g. `'+1410039940'` — The phone number of the business for which sub-account is cr
  - `companyId` [REQ]: string e.g. `'UAXssdawIWAWD'` — Company/Agency Id
  - `address` [opt]: string e.g. `'4th fleet street'` — The address of the business for which sub-account is created
  - `city` [opt]: string e.g. `'New York'` — The city where the business is located for which sub-account
  - `state` [opt]: string e.g. `'Illinois'` — The state in which the business operates for which sub-accou
  - `country` [opt]: string e.g. `'US'` — The country in which the business is present for which sub-a
  - `postalCode` [opt]: string e.g. `'567654'` — The postal code of the business for which sub-account is cre
  - `website` [opt]: string e.g. `'https://yourwebsite.com'` — The website of the business for which sub-account is created
  - `timezone` [opt]: string e.g. `'US/Central'` — The timezone of the business for which sub-account is create
  - `prospectInfo` [opt]:  e.g. `{'firstName': 'John', 'lastName': 'Doe', 'email': `
  - `settings` [opt]:  — The default settings for location
  - `social` [opt]:  — The social media links for location
  - `twilio` [opt]:  — The twilio credentials for location
  - `mailgun` [opt]:  — The mailgun credentials for location
  - `snapshot` [opt]:  — The snapshot to be updated in the location.

### DELETE `/locations/{locationId}` — Delete Sub-Account (Formerly Location)

**Query params:**

  - `deleteTwilioAccount` [REQ]: boolean — Boolean value to indicate whether to delete Twilio Account o

### GET `/locations/{locationId}/customFields` — Get Custom Fields

**Query params:**

  - `model` [opt]: string e.g. `opportunity` — Model of the custom field you want to retrieve

### POST `/locations/{locationId}/customFields` — Create Custom Field

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Custom Field'`
  - `dataType` [REQ]: string e.g. `'TEXT'`
  - `placeholder` [opt]: string e.g. `'Placeholder Text'`
  - `acceptedFormat` [opt]: array e.g. `['.pdf', '.docx', '.jpeg']`
  - `isMultipleFile` [opt]: boolean e.g. `False`
  - `maxNumberOfFiles` [opt]: number e.g. `2`
  - `textBoxListOptions` [opt]: array
  - `position` [opt]: number e.g. `0`
  - `model` [opt]: string e.g. `'opportunity'` — Model of the custom field you want to create

### POST `/locations/{locationId}/customFields/upload` — Uploads File to customFields

**Body** (multipart/form-data):

  - `id` [opt]: string e.g. `'aWdODOBVOlH1RUFKWQke'` — Id(Contact Id/Opportunity Id/Custom Field Id)
  - `maxFiles` [opt]: string e.g. `'15'` — Max number of files

### GET `/locations/{locationId}/customFields/{id}` — Get Custom Field

### PUT `/locations/{locationId}/customFields/{id}` — Update Custom Field

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Custom Field'`
  - `placeholder` [opt]: string e.g. `'Placeholder Text'`
  - `acceptedFormat` [opt]: array e.g. `['.pdf', '.docx', '.jpeg']`
  - `isMultipleFile` [opt]: boolean e.g. `False`
  - `maxNumberOfFiles` [opt]: number e.g. `2`
  - `textBoxListOptions` [opt]: array
  - `position` [opt]: number e.g. `0`
  - `model` [opt]: string e.g. `'opportunity'` — Model of the custom field you want to update

### DELETE `/locations/{locationId}/customFields/{id}` — Delete Custom Field

### GET `/locations/{locationId}/customValues` — Get Custom Values

### POST `/locations/{locationId}/customValues` — Create Custom Value

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Custom Field Name'`
  - `value` [REQ]: string e.g. `'Value'`

### GET `/locations/{locationId}/customValues/{id}` — Get Custom Value

### PUT `/locations/{locationId}/customValues/{id}` — Update Custom Value

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Custom Field Name'`
  - `value` [REQ]: string e.g. `'Value'`

### DELETE `/locations/{locationId}/customValues/{id}` — Delete Custom Value

### POST `/locations/{locationId}/recurring-tasks` — Create Recurring Task

**Body** (application/json):

  - `title` [REQ]: string e.g. `'Task Name'` — Name of the task
  - `description` [opt]: string e.g. `'Task Description'` — Description of the task
  - `contactIds` [opt]: array e.g. `['sx6wyHhbFdRXh302Lunr']` — Contact Id
  - `owners` [opt]: array e.g. `['sx6wyHhbFdRXh302Lunr']` — Assigned To
  - `rruleOptions` [REQ]:  e.g. `{'intervalType': 'hourly', 'interval': 1, 'startDa` — Recurring rules
  - `ignoreTaskCreation` [opt]: boolean e.g. `True` — Create initial task or not

### GET `/locations/{locationId}/recurring-tasks/{id}` — Get Recurring Task By Id

### PUT `/locations/{locationId}/recurring-tasks/{id}` — Update Recurring Task

**Body** (application/json):

  - `title` [opt]: string e.g. `'Task Name'` — Name of the task
  - `description` [opt]: string e.g. `'Task Description'` — Description of the task
  - `contactIds` [opt]: array e.g. `['sx6wyHhbFdRXh302Lunr']` — Contact Id
  - `owners` [opt]: array e.g. `['sx6wyHhbFdRXh302Lunr']` — Assigned To
  - `rruleOptions` [opt]:  e.g. `{'intervalType': 'hourly', 'interval': 1, 'startDa` — Recurring rules
  - `ignoreTaskCreation` [opt]: boolean e.g. `True` — Create initial task or not

### DELETE `/locations/{locationId}/recurring-tasks/{id}` — Delete Recurring Task

### GET `/locations/{locationId}/tags` — Get Tags

### POST `/locations/{locationId}/tags` — Create Tag

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Tag'` — Tag name

### GET `/locations/{locationId}/tags/{tagId}` — Get tag by id

### PUT `/locations/{locationId}/tags/{tagId}` — Update tag

**Body** (application/json):

  - `name` [REQ]: string e.g. `'Tag'` — Tag name

### DELETE `/locations/{locationId}/tags/{tagId}` — Delete tag

### POST `/locations/{locationId}/tasks/search` — Task Search Filter

**Body** (application/json):

  - `contactId` [opt]: array e.g. `['dSMo5jnqkJyh8YeGXM7k', 'j5WESpmRj816VtyUuWwh']` — Contact Ids
  - `completed` [opt]: boolean e.g. `True` — Task Completed Or Pending
  - `assignedTo` [opt]: array e.g. `['0004Mtfsd11SBU1mBPgd']` — Assigned User Ids
  - `query` [opt]: string e.g. `'Task Name'` — Search Value
  - `limit` [opt]: number e.g. `10` — Limit To Api
  - `skip` [opt]: number e.g. `10` — Number Of Tasks To Skip
  - `businessId` [opt]: string e.g. `'6348240b98722079e5417332'` — Bussiness Id

### GET `/locations/{locationId}/templates` — GET all or email/sms templates

**Query params:**

  - `deleted` [opt]: boolean
  - `skip` [opt]: string e.g. `1`
  - `limit` [opt]: string e.g. `25`
  - `type` [opt]: string
  - `originId` [REQ]: string e.g. `ve9EPM428h8vShlRW1KT` — Origin Id

### DELETE `/locations/{locationId}/templates/{id}` — DELETE an email/sms template

### GET `/locations/{locationId}/timezones` — Fetch Timezones