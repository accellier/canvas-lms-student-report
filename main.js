// ==UserScript==
// @name         Canvas Student Report Generator
// @namespace    http://tampermonkey.net/
// @version      2025-05-31
// @description  Get a student report in Canvas admin
// @author       Paul
// @match        https://*.instructure.com/accounts/*/users/*
// @match        https://*.instructure.com/users/*
// @grant        none
// @run-at document-idle
// ==/UserScript==
/* global ENV */

(function() {
    'use strict';
    // Get Canvas domain as a global constant
    const domain = window.location.origin;

    function getUserIdFromUrl() {
        const path = window.location.pathname;
        const match = path.match(/\/users\/(\d+)/);
        if (match && match[1]) {
            return match[1];
        }
        return null; // Return null if no user ID is found
    }

    /**
     * Parses the Link HTTP header to extract pagination URLs.
     * @param {string} header The Link header string.
     * @returns {object} An object where keys are rel values (e.g., 'next', 'current')
     *                   and values are the corresponding URLs.
     */
    function parseLinkHeader(header) {
        if (!header) {
            return {};
        }
        const links = {};
        const directives = header.split(',');

        directives.forEach(directive => {
            const parts = directive.split(';');
            if (parts.length === 0) return;

            const urlPart = parts[0].trim();
            const urlMatch = urlPart.match(/<(.*)>/);
            if (!urlMatch || urlMatch.length < 2) return;
            const url = urlMatch[1];

            let rel = null;
            for (let i = 1; i < parts.length; i++) {
                const paramPart = parts[i].trim();
                // Match rel="value" case insensitively for "rel" and normalize value to lowercase
                const paramMatch = paramPart.match(/rel="([^"]+)"/i);
                if (paramMatch && paramMatch.length >= 2) {
                    rel = paramMatch[1].toLowerCase();
                    break;
                }
            }

            if (rel && url) {
                links[rel] = url;
            }
        });
        return links;
    }

    /**
     * Fetches all pages of data from a paginated API endpoint.
     * @param {string} initialUrl The URL for the first page of data.
     * @param {object} headers Request headers.
     * @returns {Promise<Array>} A promise that resolves to an array containing all items from all pages.
     */
    async function fetchAllPages(initialUrl, headers) {
        let results = [];
        let currentUrl = initialUrl;

        while (currentUrl) {
            console.log(`Fetching page: ${currentUrl}`);
            const response = await fetch(currentUrl, { headers });

            if (!response.ok) {
                const errorData = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorData}, url: ${currentUrl}`);
            }

            const pageData = await response.json();
            if (Array.isArray(pageData)) {
                results = results.concat(pageData);
            } else {
                console.warn('Received non-array pageData. Assuming it is the complete, non-paginated result or a single item page.', pageData);
                results.push(pageData); // Or handle as appropriate for the API
                                        // For Canvas list APIs, pageData is expected to be an array.
            }

            const linkHeader = response.headers.get('Link');
            if (linkHeader) {
                const links = parseLinkHeader(linkHeader);
                currentUrl = links.next; // Get the URL for the next page
                if (currentUrl) {
                    console.log(`Next page URL: ${currentUrl}`);
                } else {
                    console.log('No next page found (last page processed).');
                }
            } else {
                console.log('No Link header found, assuming no more pages.');
                currentUrl = null; // No more pages
            }
        }
        return results;
    }

    /**
     * Formats an ISO date string to DD/MM/YYYY format.
     * @param {string} dateString The ISO date string (e.g., "2024-09-27T06:01:07Z").
     * @returns {string} The formatted date string "DD/MM/YYYY" or "N/A" if invalid.
     */
    function formatDate(dateString) {
        if (!dateString) {
            return 'N/A';
        }
        try {
            const date = new Date(dateString);
            const day = String(date.getDate()).padStart(2, '0');
            const month = String(date.getMonth() + 1).padStart(2, '0'); // Months are 0-indexed
            const year = date.getFullYear();
            return `${day}/${month}/${year}`;
        } catch (error) {
            return 'N/A'; // Return N/A if date parsing fails
        }
    }

    /**
     * Converts an HTML string to its plain text representation.
     * @param {string} htmlString The HTML string to convert.
     * @returns {string} The plain text representation.
     */
    function getPlainTextFromHtml(htmlString) {
        try {
            const parser = new DOMParser();
            const doc = parser.parseFromString(htmlString, 'text/html');
            return doc.body.textContent || "";
        } catch (e) {
            // Fallback for environments where DOMParser might not be ideal
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = htmlString;
            return tempDiv.textContent || tempDiv.innerText || "";
        }
    }

    /**
     * Copies HTML content to the clipboard, with a plain text fallback.
     * @param {string} htmlContent The HTML content to copy.
     * @param {HTMLElement} [buttonElement] Optional button element for feedback.
     * @returns {Promise<boolean>} True if successful, false otherwise.
     */
    async function copyHtmlToClipboard(htmlContent, buttonElement) {
        const originalButtonText = buttonElement ? buttonElement.innerText : '';
        const setButtonFeedback = (text, duration = 2000) => {
            if (buttonElement) {
                buttonElement.disabled = true;
                buttonElement.innerText = text;
                setTimeout(() => {
                    buttonElement.innerText = originalButtonText;
                    buttonElement.disabled = false;
                }, duration);
            }
        };

        if (!navigator.clipboard) {
            console.warn('Clipboard API not available.');
            setButtonFeedback('Copy Failed');
            alert('Clipboard access is not available or denied in this browser.');
            return false;
        }

        try {
            const blobHtml = new Blob([htmlContent], { type: 'text/html' });
            const plainText = getPlainTextFromHtml(htmlContent);
            const blobText = new Blob([plainText], { type: 'text/plain' });

            const item = new ClipboardItem({
                'text/html': blobHtml,
                'text/plain': blobText
            });
            await navigator.clipboard.write([item]);
            console.log('Report copied to clipboard (HTML & plain text).');
            setButtonFeedback('Copied!');
            return true;
        } catch (err) {
            console.error('Failed to copy report using ClipboardItem: ', err);
            setButtonFeedback('Copy Failed');
            alert(`Failed to copy report: ${err.message}. Your browser might not fully support this feature or permissions could be denied.`);
            return false;
        }
    }

    async function fetchAndDisplayEnrollments(userId) {
        const modalBody = document.querySelector('#student-report-modal .k-modal-body');
        if (!modalBody) {
            console.error('Modal body not found.');
            return;
        }

        modalBody.innerHTML = '<p>Loading enrolments...</p>'; // Show loading message

        if (!userId) {
            modalBody.innerHTML = '<p>Error: User ID not found in the URL.</p>';
            console.error('User ID not found in URL.');
            return;
        }

        console.log(`Fetching enrollments for user ID: ${userId}`);

        const baseEndpoint = `${domain}/api/v1/users/${userId}/courses`;

        // Define the parameter values
        const includeValues = ['course_progress', 'sections', 'concluded'];
        const stateValues = ['available', 'completed', 'deleted'];

        // Construct URLSearchParams
        const queryParams = new URLSearchParams();
        queryParams.append('per_page', '50'); // API Pagination
        includeValues.forEach(value => queryParams.append('include[]', value));
        stateValues.forEach(value => queryParams.append('state[]', value));

        const paramsString = queryParams.toString();
        const initialUrl = `${baseEndpoint}?${paramsString}`;

        console.log(`Initial API URL for enrollments: ${initialUrl}`);

        try {
            const headers = {
                'Content-Type': 'application/json'
                // Authorization handled by cookies as user will be already logged in.
            };
            const allEnrollments = await fetchAllPages(initialUrl, headers);

            console.log('All enrollments data:', allEnrollments);

            // Sort enrollments: oldest completed_at first, then newest, then nulls
            if (allEnrollments && allEnrollments.length > 0) {
                allEnrollments.sort((a, b) => {
                    const dateA = a.course_progress ? a.course_progress.completed_at : null;
                    const dateB = b.course_progress ? b.course_progress.completed_at : null;

                    if (dateA === null && dateB === null) return 0; // both null, keep original order relative to each other
                    if (dateA === null) return 1; // A is null, B is not, so B comes first (A goes to end)
                    if (dateB === null) return -1; // B is null, A is not, so A comes first (B goes to end)

                    // Both are valid dates, sort ascending (oldest first)
                    return new Date(dateA) - new Date(dateB);
                });
            }

            // Filter out enrollments where course_progress is null or requirement_count is null
            const filteredEnrollments = allEnrollments ? allEnrollments.filter(enrollment =>
                enrollment.course_progress && enrollment.course_progress.requirement_count != null) : [];

            // Calculate completedCourses and totalCourses
            const totalCourses = filteredEnrollments.length;
            let completedCourses = 0;
            if (totalCourses > 0) {
                filteredEnrollments.forEach(enrollment => {
                    // The filter ensures enrollment.course_progress exists and
                    // enrollment.course_progress.requirement_count is not null.
                    const reqCompletedCount = enrollment.course_progress.requirement_completed_count;
                    const reqCount = enrollment.course_progress.requirement_count;

                    // We also need to ensure requirement_completed_count is not null for a valid comparison.
                    if (reqCompletedCount != null && reqCompletedCount === reqCount) {
                        completedCourses++;
                    }
                });
            }

            const summaryMessage = `${completedCourses} courses out of ${totalCourses} completed`;
            const summaryHtml = `<p class="enrollment-summary"><strong>${summaryMessage}</strong></p>`;

            if (allEnrollments) { // True if fetch was successful and allEnrollments is an array (possibly empty)
                const getSafe = (fn, defaultValue = 'N/A') => {
                    try {
                        const value = fn();
                        return (value === null || typeof value === 'undefined' || value === '') ? defaultValue : value;
                    } catch (e) {
                        return defaultValue;
                    }
                };

                let finalModalContent = summaryHtml;

                if (filteredEnrollments.length > 0) {
                    let tablePortionHtml = `
                    <style>
                        #student-report-modal .enrollment-summary { margin-bottom: 15px; }
                        #student-report-modal table {
                            width: 100%;
                            border-collapse: collapse;
                            margin-top: 10px;
                            font-size: 12px; /* Smaller font for better data fit */
                        }
                        #student-report-modal th, #student-report-modal td {
                            border: 1px solid #ccc; /* Lighter border */
                            padding: 6px; /* Slightly less padding */
                            text-align: left;
                            vertical-align: top; /* Align content to top */
                            word-break: break-word; /* Break long words/strings */
                        }
                        #student-report-modal th {
                            background-color: #f0f0f0; /* Lighter header background */
                            font-weight: bold;
                        }
                        #student-report-modal tr:nth-child(even) {
                            background-color: #f9f9f9; /* Zebra striping for rows */
                        }
                        #student-report-modal th:first-child,
                        #student-report-modal td:first-child {
                            width: 25%; /* Set a specific width for the Course Name column */
                        }
                    </style>
                        <table>
                            <thead>
                                <tr>
                                    <th>Course Name</th>
                                    <th>Course Code / SIS ID</th>
                                    <th>Progress</th>
                                    <th>Completed</th>
                                    <th>Enrollment State</th>
                                </tr>
                            </thead>
                            <tbody>
                    `;

                    filteredEnrollments.forEach(enrollment => {
                        // Filter ensures enrollment.course_progress is truthy.
                        tablePortionHtml += `
                            <tr>
                                <td>${getSafe(() => enrollment.name)}</td>
                                <td>${getSafe(() => enrollment.course_code)} / ${getSafe(() => enrollment.sis_course_id)}</td>
                                <td>${getSafe(() => enrollment.course_progress.requirement_completed_count)} / ${getSafe(() => enrollment.course_progress.requirement_count)}</td>
                                <td>${formatDate(getSafe(() => enrollment.course_progress ? enrollment.course_progress.completed_at : null, null))}</td>
                                <td>${getSafe(() => enrollment.enrollments && enrollment.enrollments.length > 0 ? enrollment.enrollments[0].enrollment_state : null)}</td>
                            </tr>
                        `;
                    });
                    tablePortionHtml += `
                        </tbody>
                    </table>
                `;
                    finalModalContent += tablePortionHtml;
                    modalBody.innerHTML = finalModalContent;
                } else {
                    finalModalContent += (allEnrollments.length > 0) ?
                        '<p>No enrollments found matching the criteria (e.g., courses without progress tracking or defined requirements).</p>' :
                        '<p>No enrollments found for this user.</p>';
                    modalBody.innerHTML = finalModalContent;
                }
            } else {
                modalBody.innerHTML = '<p>Could not retrieve enrollment data. An error might have occurred.</p>';
            }
        } catch (error) {
            console.error('Error fetching enrollments:', error);
            modalBody.innerHTML = `<p>Error loading enrolments: ${error.message}</p>`;
        }
    }

    /**
     * Handles the click event for the "Copy Report" button.
     * Gathers report content and copies it to the clipboard.
     * @param {Event} event The click event.
     */
    async function handleCopyReportClick(event) {
        const buttonElement = event.currentTarget;
        const modal = document.getElementById('student-report-modal');
        if (!modal) {
            console.error('Modal not found for copying.');
            return;
        }

        const titleElement = modal.querySelector('.k-modal-title');
        const bodyElement = modal.querySelector('.k-modal-body');

        if (!titleElement || !bodyElement) {
            console.error('Modal title or body not found for copying.');
            return;
        }


        let htmlToCopy = '';

        if (titleElement) {
            htmlToCopy += `<h2>${titleElement.innerText}</h2>\n`;
        }

        const summaryElement = bodyElement.querySelector('.enrollment-summary');
        if (summaryElement) {
            htmlToCopy += summaryElement.outerHTML + '\n';
        }

        const tableElement = bodyElement.querySelector('table');

        if (tableElement) {
            // Clone the table to modify it for copying without affecting the displayed table
            const clonedTable = tableElement.cloneNode(true);

            // Copied data removes the "Enrollment State" column (5th column, index 4)
            const headerRow = clonedTable.querySelector('thead tr');
            if (headerRow && headerRow.children.length > 4) {
                headerRow.children[4].remove(); // Remove 5th th
            }

            const bodyRows = clonedTable.querySelectorAll('tbody tr');
            bodyRows.forEach(row => {
                if (row.children.length > 4) {
                    row.children[4].remove(); // Remove 5th td from each row
                }
            });

            // Apply inline styles to the cloned table
            clonedTable.style.width = '100%';
            clonedTable.style.borderCollapse = 'collapse';
            clonedTable.style.marginTop = '10px';
            clonedTable.style.fontSize = '12px';
            clonedTable.style.border = '1px solid #ccc'; // Add border to the table itself for some clients

            const cells = clonedTable.querySelectorAll('th, td');
            cells.forEach(cell => {
                cell.style.border = '1px solid #ccc';
                cell.style.padding = '6px';
                cell.style.textAlign = 'left';
                cell.style.verticalAlign = 'top';
                cell.style.wordBreak = 'break-word';
            });

            const thCells = clonedTable.querySelectorAll('th');
            thCells.forEach(th => {
                th.style.backgroundColor = '#f0f0f0';
                th.style.fontWeight = 'bold';
            });

            const tbodyRows = clonedTable.querySelectorAll('tbody tr');
            tbodyRows.forEach((row, index) => {
                if (index % 2 === 1) {
                    row.style.backgroundColor = '#f9f9f9';
                }
            });

            // Set width for the first column cells (Course Name after Enrollment State is removed)
            const firstColumnHeader = clonedTable.querySelector('thead tr th:first-child');
            if (firstColumnHeader) firstColumnHeader.style.width = '25%';
            tbodyRows.forEach(row => {
                const firstCell = row.querySelector('td:first-child');
                if (firstCell) firstCell.style.width = '25%';
            });

            htmlToCopy += clonedTable.outerHTML;
        } else {
            // If no table, copy other message paragraphs from the body (excluding summary, already added)
            const messageParagraphs = Array.from(bodyElement.querySelectorAll(':scope > p:not(.enrollment-summary)'));
            messageParagraphs.forEach(p => {
                htmlToCopy += p.outerHTML + '\n';
            });
        }
        htmlToCopy = htmlToCopy.trim();

        if (htmlToCopy) {
            await copyHtmlToClipboard(htmlToCopy, buttonElement);
        } else {
            console.warn('No content formatted for copying.');
            const originalText = buttonElement.innerText;
            buttonElement.innerText = 'Nothing to Copy';
            buttonElement.disabled = true;
            setTimeout(() => {
                buttonElement.innerText = originalText;
                buttonElement.disabled = false;
            }, 2000);
        }
    }

    function injectReportButtonAndModal() {
        const rightSide = document.getElementById('right-side');

        if (rightSide) {
            const existingButtonContainer = rightSide.querySelector('div');

            if (existingButtonContainer) {
                const newButtonDiv = document.createElement('div');
                newButtonDiv.innerHTML = `
                    <a href="#" id="student-report-button" class="btn button-sidebar-wide">
                        <i class="icon-document"></i>
                        Student Report
                    </a>
                `;
                existingButtonContainer.after(newButtonDiv);

                const studentReportButton = document.getElementById('student-report-button');

                // Get the student's name from the page
                const studentNameElement = document.querySelector('.short_name');
                const studentName = studentNameElement ? studentNameElement.innerText : 'Student'; // Fallback if not found

                const modalHtml = `
                    <div id="student-report-modal" class="k-modal" style="display: none;
                        position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
                        z-index: 10000;
                        max-width: 90%; max-height: 90vh;
                        overflow-y: auto;
                    ">
                        <div class="k-modal-dialog">
                            <div class="k-modal-content" style="
                                background-color: #fff; /* White background */
                                border: 1px solid #ccc; /* Light grey border */
                                border-radius: 4px; /* Slightly rounded corners */
                                box-shadow: 0 5px 15px rgba(0,0,0,.5); /* Subtle shadow */
                                padding: 20px; /* Add some internal padding for content */
                                box-sizing: border-box; /* Include padding and border in the element's total width and height */
                            ">
                                <div class="k-modal-header">
                                    <h2 class="k-modal-title">Student Report: ${studentName}</h2>
                                    <button type="button" class="k-modal-close-button close-modal" aria-label="Close" style="
                                        position: absolute;
                                        top: 10px;
                                        right: 15px;
                                        font-size: 1.5rem;
                                        background: none;
                                        border: none;
                                        cursor: pointer;
                                    ">&times;</button>
                                </div>
                                <div class="k-modal-body">
                                    <p>Loading report data...</p>
                                </div>
                                <div class="k-modal-footer">
                                    <button type="button" class="btn" id="copy-report-button">Copy Report</button>
                                    <button type="button" class="btn cancel_button close-modal" style="margin-left: 8px;">Close</button>
                                </div>
                            </div>
                        </div>
                        <div class="k-modal-overlay"></div>
                    </div>
                `;

                document.body.insertAdjacentHTML('beforeend', modalHtml);

                const studentReportModal = document.getElementById('student-report-modal');
                const closeModalButtons = studentReportModal.querySelectorAll('.close-modal, .k-modal-close-button');
                const modalOverlay = studentReportModal.querySelector('.k-modal-overlay');
                const copyReportButton = document.getElementById('copy-report-button');

                if (studentReportButton && studentReportModal) {
                    studentReportButton.addEventListener('click', function(e) {
                        e.preventDefault();
                        studentReportModal.style.display = 'block';
                        studentReportModal.setAttribute('aria-hidden', 'false');
                        // Fetch and display enrollments when the modal opens
                        const userId = getUserIdFromUrl();
                        fetchAndDisplayEnrollments(userId);
                    });

                    closeModalButtons.forEach(button => {
                        button.addEventListener('click', function() {
                            studentReportModal.style.display = 'none';
                            studentReportModal.setAttribute('aria-hidden', 'true');
                        });
                    });

                    modalOverlay.addEventListener('click', function() {
                        studentReportModal.style.display = 'none';
                        studentReportModal.setAttribute('aria-hidden', 'true');
                    });
                }

                if (copyReportButton) {
                    copyReportButton.addEventListener('click', handleCopyReportClick);
                }
            } else {
                console.warn('Existing button container not found within #right-side.');
            }
        } else {
            console.warn('#right-side element not found. Cannot inject button.');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectReportButtonAndModal);
    } else {
        injectReportButtonAndModal();
    }
})();
