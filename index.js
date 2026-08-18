let allContacts = [];      // currently loaded (selected year's) contacts
let contactsByStatus = {};
let activeStatus = null;
let currentFetchId = 0;    // guards against race conditions between year switches
let ownerIdToName = {};    // maps Owner id -> Owner full name

// Base URL to build direct links to individual Contact records
const CONTACT_RECORD_BASE_URL = "https://crmplus.zoho.com/proctorgallagherinstitute/index.do/cxapp/crm/org908687475/tab/Contacts/";

// Initialize Zoho Embedded App SDK
ZOHO.embeddedApp.on("PageLoad", async function (data) {
  ZOHO.CRM.UI.Resize({ height: "700px", width: "50%" }).then(function () {
    console.log("Widget resized");
  });

  populateYearDropdown();
  // Thoda delay do taaki SDK ka parent-window bridge fully ready ho jaye
  setTimeout(async function () {
    await fetchAllUsers();          // owner id->name map ek hi baar bana lo
    await fetchContactsForYear(getSelectedYear());
  }, 400);
});
ZOHO.embeddedApp.init();

function getSelectedYear() {
  return parseInt(document.getElementById("yearSelect").value);
}

// Fetch all CRM Users once, build an id -> full_name map.
async function fetchAllUsers() {
  try {
    const response = await ZOHO.CRM.API.getAllRecords({
      Entity: "users",
      sort_order: "asc",
      per_page: 200
    });
    if (response && response.users) {
      response.users.forEach(user => {
        ownerIdToName[user.id] = user.full_name || user.name || "Unknown";
      });
    }
  } catch (error) {
    console.error("Error fetching Users:", error);
  }
}

// Helper: safely resolve Owner name from the contact's Owner.id via the map
function getOwnerName(contact) {
  const ownerId = contact.Owner && contact.Owner.id;
  if (!ownerId) return null;
  return ownerIdToName[ownerId] || null;
}

// Helper: build a direct link to a Contact's record page
function getContactRecordUrl(contact) {
  if (!contact || !contact.id) return null;
  return `${CONTACT_RECORD_BASE_URL}${contact.id}`;
}

// Populate Year Dropdown dynamically (e.g., last 5 years + next year)
function populateYearDropdown() {
  const yearSelect = document.getElementById("yearSelect");
  const currentYear = new Date().getFullYear();
  for (let year = currentYear + 1; year >= currentYear - 5; year--) {
    const option = document.createElement("option");
    option.value = year;
    option.text = year;
    if (year === currentYear) option.selected = true;
    yearSelect.appendChild(option);
  }
  // Year change -> re-fetch only that year's data from CRM
  yearSelect.addEventListener("change", async function () {
    await fetchContactsForYear(getSelectedYear());
  });
}

// Populate Owner Dropdown dynamically from currently loaded (selected year's) Contacts
function populateOwnerDropdown() {
  const ownerSelect = document.getElementById("ownerSelect");
  const previousValue = ownerSelect.value || "All";

  const ownerNames = new Set();
  allContacts.forEach(contact => {
    const ownerName = getOwnerName(contact);
    if (ownerName) ownerNames.add(ownerName);
  });

  ownerSelect.innerHTML = `<option value="All">All Owners</option>`;

  Array.from(ownerNames).sort().forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.text = name;
    ownerSelect.appendChild(option);
  });

  if ([...ownerSelect.options].some(o => o.value === previousValue)) {
    ownerSelect.value = previousValue;
  }

  ownerSelect.addEventListener("change", renderStatuses);
}

// Fetch ONLY the selected year's Contacts using COQL (Created_Time range — the
// actual date field; Created_By is only the user reference, not a date),
// split month-by-month to stay under Zoho's 2000-offset limit per query.
// Months are fetched in small parallel batches to balance speed vs rate limits.
async function fetchContactsForYear(year) {
  const container = document.getElementById("statusContainer");
  container.innerHTML = `<p class="loading-text">Loading Contacts for ${year}...</p>`;

  currentFetchId += 1;
  const thisFetchId = currentFetchId;

  const limit = 200;
  const maxOffset = 2000;
  const batchSize = 4; // kitne months ek saath parallel chalenge (rate-limit safe)

  async function fetchMonth(month) {
    const monthStr = String(month).padStart(2, "0");
    const lastDay = new Date(year, month, 0).getDate();
    const startDate = `${year}-${monthStr}-01T00:00:00+00:00`;
    const endDate = `${year}-${monthStr}-${lastDay}T23:59:59+00:00`;

    const monthContacts = [];
    let offset = 0;
    let moreRecords = true;

    while (moreRecords) {
      if (thisFetchId !== currentFetchId) return monthContacts;

      if (offset > maxOffset) {
        console.warn(`Offset limit reached for ${year}-${monthStr}, some records may be skipped.`);
        break;
      }

      const query = `select First_Name, Last_Name, Email, Phone, Status, Owner, Created_By, Created_Time from Contacts where Created_Time between '${startDate}' and '${endDate}' limit ${limit} offset ${offset}`;

      try {
        const response = await ZOHO.CRM.API.coql({ select_query: query });

        if (thisFetchId !== currentFetchId) return monthContacts;

        if (response && response.data && response.data.length > 0) {
          monthContacts.push(...response.data);
        }

        moreRecords = !!(response && response.info && response.info.more_records) && response.data && response.data.length === limit;
        offset += limit;
      } catch (err) {
        console.error(`Error fetching ${year}-${monthStr}:`, err);
        break;
      }
    }

    return monthContacts;
  }

  try {
    const allMonths = Array.from({ length: 12 }, (_, i) => i + 1);
    const yearContacts = [];

    for (let i = 0; i < allMonths.length; i += batchSize) {
      if (thisFetchId !== currentFetchId) return;

      const batch = allMonths.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(m => fetchMonth(m)));

      if (thisFetchId !== currentFetchId) return;

      batchResults.forEach(contacts => yearContacts.push(...contacts));
    }

    if (thisFetchId !== currentFetchId) return;

    allContacts = yearContacts;

    if (allContacts.length > 0) {
      populateOwnerDropdown();
      renderStatuses();
    } else {
      container.innerHTML = `<p>No Contacts found for ${year}.</p>`;
    }
  } catch (error) {
    if (thisFetchId !== currentFetchId) return;
    console.error("Error fetching Contacts:", error);
    container.innerHTML = "<p>Error loading Contacts data. Check console (F12) for details.</p>";
  }
}

// Render Status rows (one below another). allContacts is already scoped to the selected year.
function renderStatuses() {
  const selectedOwner = document.getElementById("ownerSelect").value;
  const container = document.getElementById("statusContainer");
  container.innerHTML = "";
  activeStatus = null;

  const filteredContacts = allContacts.filter(contact => {
    if (selectedOwner !== "All") {
      const ownerName = getOwnerName(contact);
      if (ownerName !== selectedOwner) return false;
    }
    return true;
  });

  contactsByStatus = {};
  filteredContacts.forEach(contact => {
    const status = contact.Status || "Unassigned";
    if (!contactsByStatus[status]) {
      contactsByStatus[status] = [];
    }
    contactsByStatus[status].push(contact);
  });

  if (Object.keys(contactsByStatus).length === 0) {
    container.innerHTML = `<p>No Contacts found for the selected filters.</p>`;
    return;
  }

  Object.keys(contactsByStatus).forEach(status => {
    const statusBlock = document.createElement("div");
    statusBlock.className = "status-block";
    statusBlock.id = "status-" + status.replace(/\s+/g, "-");

    const pill = document.createElement("button");
    pill.className = "status-pill";
    pill.type = "button";
    pill.innerHTML = `<span>${status} (${contactsByStatus[status].length})</span><span class="status-arrow">&#9656;</span>`;
    pill.addEventListener("click", () => toggleStatus(status, statusBlock));

    const contactsList = document.createElement("div");
    contactsList.className = "contacts-list";
    contactsByStatus[status].forEach(contact => {
      const contactCard = document.createElement("div");
      contactCard.className = "contact-card";
      const ownerName = getOwnerName(contact) || "N/A";
      const recordUrl = getContactRecordUrl(contact);
      const fullName = [contact.First_Name, contact.Last_Name].filter(Boolean).join(" ") || "Unnamed Contact";

      const contactNameHtml = recordUrl
        ? `<a href="${recordUrl}" target="_blank" rel="noopener noreferrer" style="color:#1d4ed8; text-decoration:none;">${fullName}</a>`
        : fullName;

      contactCard.innerHTML = `
        <div class="contact-name">${contactNameHtml}</div>
        <div class="contact-info">Email: ${contact.Email || "N/A"}</div>
        <div class="contact-info">Phone: ${contact.Phone || "N/A"}</div>
        <div class="contact-info">Owner: ${ownerName}</div>
      `;
      contactsList.appendChild(contactCard);
    });

    statusBlock.appendChild(pill);
    statusBlock.appendChild(contactsList);
    container.appendChild(statusBlock);
  });
}

// Expand/collapse the clicked Status's contacts, right below its own row
function toggleStatus(status, statusBlockEl) {
  const wasActive = statusBlockEl.classList.contains("active");

  document.querySelectorAll(".status-block.active").forEach(el => el.classList.remove("active"));

  if (wasActive) {
    activeStatus = null;
  } else {
    activeStatus = status;
    statusBlockEl.classList.add("active");
  }
}
