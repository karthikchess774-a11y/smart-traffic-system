import * as maplibregl from
    "https://unpkg.com/maplibre-gl@6.11.2/dist/maplibre-gl.mjs";

// Protect the dashboard page: only authenticated users may use it.
const authResponse = await fetch("/api/auth/me", { credentials: "same-origin" });
if (!authResponse.ok) {
    window.location.replace("/login.html");
    throw new Error("Authentication required");
}
const authenticatedUser = (await authResponse.json()).user;

// Add a compact account/logout control without changing the existing dashboard markup.
const accountBar = document.createElement("div");
accountBar.style.cssText = "display:flex;justify-content:flex-end;align-items:center;gap:12px;padding:10px 4%;background:#091a2e;color:#dbeafe;font:13px Arial,sans-serif";
const accountLabel = document.createElement("span");
accountLabel.textContent = `Signed in as ${authenticatedUser.name}`;
const logoutButton = document.createElement("button");
logoutButton.type = "button";
logoutButton.textContent = "Log out";
logoutButton.style.cssText = "width:auto;margin:0;padding:8px 14px;border:1px solid #365777;border-radius:8px;background:#173b63;color:white;cursor:pointer";
logoutButton.addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    window.location.replace("/login.html");
});
accountBar.append(accountLabel, logoutButton);
document.body.insertBefore(accountBar, document.body.firstChild);


// =====================================================
// BACKEND
// =====================================================

const BACKEND_URL = "";


// =====================================================
// MAP
// =====================================================

let map = null;

// =====================================================
// MANUAL TRAFFIC SCANNER STATE
// =====================================================
let manualScanCenter = null; // { latitude, longitude }
let manualScanRadiusKm = 5;
let manualScanChooseMode = false;
let manualScanDragging = false;
let manualScanDragOffset = null;
let manualScanInProgress = false;


// =====================================================
// GPS
// =====================================================

let gpsWatchId = null;

let journeyActive = false;

let currentPosition = null;

let currentRoute = null;
let availableRoutes = [];
let selectedRouteIndex = 0;

let currentFromLocation = "";

let currentDestination = "";

let currentDestinationCoordinates = null;

let lastDynamicRouteCheck = 0;

let dynamicRouteChecking = false;


// =====================================================
// BROWSER NOTIFICATIONS
// =====================================================

let notificationPermissionRequested = false;

let lastNotificationLevel = "NORMAL";

let lastNotificationTime = 0;

const NOTIFICATION_COOLDOWN = 60000;


// REQUEST NOTIFICATION PERMISSION
async function requestNotificationPermission() {

    if (!("Notification" in window)) {

        console.warn(
            "Browser notifications are not supported."
        );

        return false;
    }


    if (Notification.permission === "granted") {

        return true;
    }


    if (Notification.permission === "denied") {

        console.warn(
            "Notification permission is blocked."
        );

        return false;
    }


    if (notificationPermissionRequested) {

        return false;
    }


    notificationPermissionRequested = true;


    try {

        const permission =
            await Notification.requestPermission();


        console.log(
            "🔔 Notification permission:",
            permission
        );


        return permission === "granted";

    }

    catch (error) {

        console.error(
            "Notification permission error:",
            error
        );

        return false;
    }
}


// SEND TRAFFIC NOTIFICATION
function sendTrafficNotification(
    level,
    delayMinutes,
    worstDirection
) {

    if (
        !("Notification" in window)
    ) {

        return;
    }


    if (
        Notification.permission !==
        "granted"
    ) {

        return;
    }


    const now =
        Date.now();


    if (
        now -
        lastNotificationTime <
        NOTIFICATION_COOLDOWN
    ) {

        return;
    }


    if (
        level ===
        lastNotificationLevel &&
        level ===
        "NORMAL"
    ) {

        return;
    }


    let title = "";

    let message = "";


    if (
        level ===
        "MODERATE"
    ) {

        title =
            "🟠 Traffic Alert";


        message =
            `Moderate traffic detected within 5 km. ` +
            `Expected delay: ${delayMinutes} min. ` +
            `Direction: ${worstDirection}.`;

    }


    else if (
        level ===
        "HEAVY"
    ) {

        title =
            "🔴 Heavy Traffic Alert";


        message =
            `Heavy traffic detected within 5 km. ` +
            `Expected delay: ${delayMinutes} min. ` +
            `Direction: ${worstDirection}.`;

    }


    else {

        return;
    }


    try {

        new Notification(
            title,
            {
                body:
                    message,

                tag:
                    "smart-traffic-alert",

                renotify:
                    true
            }
        );


        lastNotificationLevel =
            level;


        lastNotificationTime =
            now;


        console.log(
            "🔔 Traffic notification sent."
        );

    }

    catch (error) {

        console.error(
            "Notification error:",
            error
        );

    }

}


// =====================================================
// MAP SOURCES
// =====================================================

let routeSourceReady = false;

let monitoringSourceReady = false;

let userLocationSourceReady = false;


// =====================================================
// INITIALIZE MAP
// =====================================================

function initializeMap() {

    map = new maplibregl.Map({

        container: "map",

        style:
            "https://tiles.openfreemap.org/styles/liberty",

        center: [
            79.5941,
            17.9689
        ],

        zoom: 14,

        pitch: 0,

        bearing: 0,

        attributionControl: true,

        dragRotate: false,

        touchZoomRotate: true,

        doubleClickZoom: true,

        scrollZoom: true,

        boxZoom: true,

        keyboard: true

    });


    map.addControl(

        new maplibregl.NavigationControl({

            showCompass: false,

            showZoom: true

        }),

        "top-right"

    );


    map.dragRotate.disable();

    map.touchZoomRotate.disableRotation();


    map.on(
        "load",
        function () {

            console.log(
                "🗺️ MapLibre loaded."
            );

            createMapSources();

        }
    );


    map.on(
        "error",
        function (event) {

            console.error(
                "MapLibre error:",
                event
            );

        }
    );

}


// =====================================================
// CREATE MAP SOURCES
// =====================================================

function createMapSources() {

    map.addSource(

        "routes-source",

        {

            type:
                "geojson",

            data: {

                type:
                    "FeatureCollection",

                features: []

            }

        }

    );


    map.addSource(

        "monitoring-source",

        {

            type:
                "geojson",

            data: {

                type:
                    "FeatureCollection",

                features: []

            }

        }

    );


    map.addSource(

        "accuracy-source",

        {

            type:
                "geojson",

            data: {

                type:
                    "FeatureCollection",

                features: []

            }

        }

    );


    map.addSource(

        "user-location-source",

        {

            type:
                "geojson",

            data: {

                type:
                    "FeatureCollection",

                features: []

            }

        }

    );


    // MANUAL SCAN CIRCLE + CENTER HANDLE
    map.addSource("manual-scan-source", {
        type: "geojson",
        data: {
            type: "FeatureCollection",
            features: []
        }
    });


    // GPS ACCURACY

    map.addLayer({

        id:
            "accuracy-fill",

        type:
            "fill",

        source:
            "accuracy-source",

        paint: {

            "fill-color":
                "#4285f4",

            "fill-opacity":
                0.12

        }

    });


    map.addLayer({

        id:
            "accuracy-line",

        type:
            "line",

        source:
            "accuracy-source",

        paint: {

            "line-color":
                "#4285f4",

            "line-width":
                1,

            "line-opacity":
                0.35

        }

    });


    // 5 KM MONITORING AREA

    map.addLayer({

        id:
            "monitoring-fill",

        type:
            "fill",

        source:
            "monitoring-source",

        paint: {

            "fill-color":
                "#7e57c2",

            "fill-opacity":
                0.08

        }

    });


    map.addLayer({

        id:
            "monitoring-line",

        type:
            "line",

        source:
            "monitoring-source",

        paint: {

            "line-color":
                "#7e57c2",

            "line-width":
                2,

            "line-opacity":
                0.8,

            "line-dasharray": [
                2,
                2
            ]

        }

    });


    // MANUAL SCAN AREA (separate from the GPS monitoring circle)
    map.addLayer({
        id: "manual-scan-fill",
        type: "fill",
        source: "manual-scan-source",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
            "fill-color": "#0891b2",
            "fill-opacity": 0.13
        }
    });

    map.addLayer({
        id: "manual-scan-line",
        type: "line",
        source: "manual-scan-source",
        filter: ["==", ["geometry-type"], "Polygon"],
        paint: {
            "line-color": "#0891b2",
            "line-width": 3,
            "line-dasharray": [2, 1]
        }
    });

    map.addLayer({
        id: "manual-scan-center",
        type: "circle",
        source: "manual-scan-source",
        filter: ["==", ["geometry-type"], "Point"],
        paint: {
            "circle-radius": 7,
            "circle-color": "#0891b2",
            "circle-stroke-color": "#ffffff",
            "circle-stroke-width": 2
        }
    });


    // OTHER ROUTES

    map.addLayer({

        id:
            "route-other",

        type:
            "line",

        source:
            "routes-source",

        filter: [

            ">",

            [
                "get",
                "routeIndex"
            ],

            1

        ],

        layout: {

            "line-cap":
                "round",

            "line-join":
                "round"

        },

        paint: {

            "line-color":
                "#8bc34a",

            "line-width":
                4,

            "line-opacity":
                0.65,

            "line-dasharray": [
                2,
                2
            ]

        }

    });


    // ALTERNATE ROUTE

    map.addLayer({

        id:
            "route-alternate",

        type:
            "line",

        source:
            "routes-source",

        filter: [

            "==",

            [
                "get",
                "routeIndex"
            ],

            1

        ],

        layout: {

            "line-cap":
                "round",

            "line-join":
                "round"

        },

        paint: {

            "line-color":
                "#ff9800",

            "line-width":
                5,

            "line-opacity":
                0.8,

            "line-dasharray": [
                2,
                2
            ]

        }

    });


    // FASTEST ROUTE

    map.addLayer({

        id:
            "route-fastest",

        type:
            "line",

        source:
            "routes-source",

        filter: [

            "==",

            [
                "get",
                "routeIndex"
            ],

            0

        ],

        layout: {

            "line-cap":
                "round",

            "line-join":
                "round"

        },

        paint: {

            "line-color":
                "#1565ff",

            "line-width":
                7,

            "line-opacity":
                0.95

        }

    });


    // USER LOCATION HALO

    map.addLayer({

        id:
            "user-location-halo",

        type:
            "circle",

        source:
            "user-location-source",

        paint: {

            "circle-radius":
                13,

            "circle-color":
                "#4285f4",

            "circle-opacity":
                0.22,

            "circle-stroke-width":
                0

        }

    });


    // USER LOCATION WHITE BORDER

    map.addLayer({

        id:
            "user-location-border",

        type:
            "circle",

        source:
            "user-location-source",

        paint: {

            "circle-radius":
                9,

            "circle-color":
                "#ffffff",

            "circle-opacity":
                1

        }

    });


    // USER LOCATION BLUE DOT

    map.addLayer({

        id:
            "user-location-dot",

        type:
            "circle",

        source:
            "user-location-source",

        paint: {

            "circle-radius":
                6,

            "circle-color":
                "#1a73e8",

            "circle-opacity":
                1

        }

    });


    routeSourceReady = true;

    monitoringSourceReady = true;

    userLocationSourceReady = true;


    setupManualTrafficScanner();

    console.log(
        "🗺️ All map layers ready."
    );

}


// =====================================================
// UPDATE BLUE GPS LOCATION
// =====================================================

function updateUserLocationMarker(
    latitude,
    longitude
) {

    if (
        !userLocationSourceReady
    ) {
        return;
    }


    const source =
        map.getSource(
            "user-location-source"
        );


    if (!source) {
        return;
    }


    source.setData({

        type:
            "FeatureCollection",

        features: [

            {

                type:
                    "Feature",

                properties: {},

                geometry: {

                    type:
                        "Point",

                    coordinates: [

                        longitude,

                        latitude

                    ]

                }

            }

        ]

    });


    console.log(
        "🔵 Blue GPS marker:",
        latitude,
        longitude
    );

}


// =====================================================
// BACKEND STATUS
// =====================================================

async function checkBackend() {

    const status =
        document.getElementById(
            "backendStatus"
        );


    if (!status) {
        return;
    }


    try {

        const response =
            await fetch(
                `${BACKEND_URL}/api/status`
            );


        const data =
            await response.json();


        if (
            data.status ===
            "success"
        ) {

            status.innerHTML =
                "🟢 Backend Connected Successfully";

            status.style.color =
                "green";

        }

        else {

            status.innerHTML =
                "🔴 Backend Error";

            status.style.color =
                "red";

        }

    }

    catch (error) {

        console.error(error);


        status.innerHTML =
            "🔴 Backend Not Connected";

        status.style.color =
            "red";

    }

}


// =====================================================
// GEOCODING
// =====================================================

function distanceBetweenCoordinatesKm(pointA, pointB) {
    const toRadians = value => value * Math.PI / 180;
    const lat1 = toRadians(Number(pointA.lat));
    const lat2 = toRadians(Number(pointB.lat));
    const deltaLat = toRadians(Number(pointB.lat) - Number(pointA.lat));
    const deltaLon = toRadians(Number(pointB.lon) - Number(pointA.lon));

    const a =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) * Math.cos(lat2) *
        Math.sin(deltaLon / 2) ** 2;

    return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


// Search multiple Indian matches. If a reliable starting point is available,
// prefer a matching place near that point; otherwise ask the user to disambiguate.
async function geocodeLocation(location, referencePoint = null) {
    const query = String(location || "").trim();

    if (!query) {
        throw new Error("Please enter a location.");
    }

    const params = new URLSearchParams({
        format: "jsonv2",
        q: query,
        countrycodes: "in",
        limit: "10",
        addressdetails: "1",
        "accept-language": "en"
    });

    // Bias the search toward the selected start area without excluding
    // other Indian matches (bounded=0). This helps local village names.
    if (referencePoint &&
        Number.isFinite(Number(referencePoint.lat)) &&
        Number.isFinite(Number(referencePoint.lon))) {
        const lat = Number(referencePoint.lat);
        const lon = Number(referencePoint.lon);
        params.set("viewbox", [
            lon - 1.5,
            lat + 1.5,
            lon + 1.5,
            lat - 1.5
        ].join(","));
        params.set("bounded", "0");
    }

    const response = await fetch(
        `https://nominatim.openstreetmap.org/search?${params.toString()}`,
        { headers: { "Accept": "application/json" } }
    );

    if (!response.ok) {
        throw new Error("Unable to contact location service. Please try again.");
    }

    const data = await response.json();

    if (!Array.isArray(data) || data.length === 0) {
        throw new Error(
            `No matching Indian location found for "${query}". Try adding the mandal, district or state.`
        );
    }

    const candidates = data
        .map(item => ({
            lat: Number.parseFloat(item.lat),
            lon: Number.parseFloat(item.lon),
            displayName: item.display_name,
            type: item.type || item.addresstype || "place"
        }))
        .filter(item =>
            Number.isFinite(item.lat) &&
            Number.isFinite(item.lon)
        );

    if (!candidates.length) {
        throw new Error(`Could not read coordinates for "${query}".`);
    }

    if (candidates.length === 1) {
        return candidates[0];
    }

    if (referencePoint &&
        Number.isFinite(Number(referencePoint.lat)) &&
        Number.isFinite(Number(referencePoint.lon))) {

        const ranked = candidates
            .map(candidate => ({
                ...candidate,
                distanceKm: distanceBetweenCoordinatesKm(referencePoint, candidate)
            }))
            .sort((a, b) => a.distanceKm - b.distanceKm);

        // Prefer a same-name match within 150 km of the selected start point.
        // Do not silently choose a far-away city with the same name.
        if (ranked[0].distanceKm <= 150) {
            console.info(
                `📍 Selected nearby match for "${query}":`,
                ranked[0].displayName,
                `(${ranked[0].distanceKm.toFixed(1)} km from start)`
            );
            return ranked[0];
        }
    }

    const options = candidates.slice(0, 8);
    const optionText = options
        .map((item, index) => {
            const distance = referencePoint
                ? ` — ${distanceBetweenCoordinatesKm(referencePoint, item).toFixed(1)} km from start`
                : "";
            return `${index + 1}. ${item.displayName}${distance}`;
        })
        .join("\\n");

    const answer = window.prompt(
        `More than one place matches "${query}". Enter the number of the correct place:\\n\\n${optionText}\\n\\nCancel to edit the location name.`,
        "1"
    );

    if (answer === null) {
        throw new Error("Location selection cancelled. Please enter a more specific place name.");
    }

    const selectedIndex = Number.parseInt(answer, 10) - 1;

    if (!Number.isInteger(selectedIndex) ||
        selectedIndex < 0 ||
        selectedIndex >= options.length) {
        throw new Error("Invalid place selection. Please search again.");
    }

    return options[selectedIndex];
}


// =====================================================
// FORMAT TIME
// =====================================================

function formatTime(
    seconds
) {

    const minutes =
        Math.round(
            Number(seconds || 0) / 60
        );


    if (
        minutes < 60
    ) {

        return `${minutes} min`;

    }


    const hours =
        Math.floor(
            minutes / 60
        );


    const remaining =
        minutes % 60;


    return `${hours} hr ${remaining} min`;

}


// =====================================================
// FORMAT DISTANCE
// =====================================================

function formatDistance(
    meters
) {

    if (
        meters < 1000
    ) {

        return `${Math.round(meters)} m`;

    }


    return `${(
        meters / 1000
    ).toFixed(2)} km`;

}

// =====================================================
// JOURNEY PLANNING - TARGET ARRIVAL TIME
// =====================================================

function updateJourneyPlanning(travelTimeInSeconds) {

    const planningElement =
        document.getElementById("journeyPlanning");

    const arrivalInput =
        document.getElementById("targetArrivalTime");

    if (!planningElement || !arrivalInput) {
        return;
    }

    const targetTime =
        arrivalInput.value;

    if (!targetTime) {

        planningElement.innerHTML = `
            <p>
                ⏰ Please select your target arrival time.
            </p>
        `;

        return;
    }

    const parts =
        targetTime.split(":");

    const targetHours =
        Number(parts[0]);

    const targetMinutes =
        Number(parts[1]);

    if (
        isNaN(targetHours) ||
        isNaN(targetMinutes)
    ) {

        planningElement.innerHTML = `
            <p>
                ⚠️ Invalid target arrival time.
            </p>
        `;

        return;
    }

    // TomTom travel time already
    // includes live traffic conditions.
    const travelMinutes =
        Math.ceil(
            Number(travelTimeInSeconds || 0) / 60
        );

    // 5-minute safety buffer
    const safetyBuffer = 5;

    const totalMinutes =
        travelMinutes +
        safetyBuffer;

    // Convert target time to minutes
    const targetTotalMinutes =
        targetHours * 60 +
        targetMinutes;

    // Calculate departure time
    let departureTotalMinutes =
        targetTotalMinutes -
        totalMinutes;

    // Previous-day handling
    if (departureTotalMinutes < 0) {

        departureTotalMinutes +=
            24 * 60;
    }

    const departureHours =
        Math.floor(
            departureTotalMinutes / 60
        );

    const departureMinutes =
        departureTotalMinutes % 60;

    // Convert to 12-hour format
    function format12Hour(
        hours,
        minutes
    ) {

        const period =
            hours >= 12
                ? "PM"
                : "AM";

        let displayHour =
            hours % 12;

        if (displayHour === 0) {
            displayHour = 12;
        }

        return `${displayHour}:${String(
            minutes
        ).padStart(2, "0")} ${period}`;
    }

    const targetDisplay =
        format12Hour(
            targetHours,
            targetMinutes
        );

    const departureDisplay =
        format12Hour(
            departureHours,
            departureMinutes
        );

    planningElement.innerHTML = `

        <div style="
            padding: 16px;
            border-radius: 12px;
            background: #f8fafc;
            border: 1px solid #e5e7eb;
        ">

            <div style="
                font-size: 18px;
                font-weight: 700;
                margin-bottom: 15px;
            ">
                ⏰ Journey Planning
            </div>

            <div style="margin-bottom: 10px;">
                🎯 Target Arrival:
                <strong>
                    ${targetDisplay}
                </strong>
            </div>

            <div style="margin-bottom: 10px;">
                🚗 Estimated Travel Time:
                <strong>
                    ${formatTime(
                        travelTimeInSeconds
                    )}
                </strong>
            </div>

            <div style="margin-bottom: 10px;">
                🛡️ Safety Buffer:
                <strong>
                    ${safetyBuffer} min
                </strong>
            </div>

            <hr style="
                margin: 15px 0;
                border: none;
                border-top: 1px solid #ddd;
            ">

            <div style="
                padding: 12px;
                border-radius: 10px;
                background: #e8f5e9;
                color: #166534;
                font-size: 18px;
                font-weight: 700;
            ">
                🚦 Recommended Departure:
                <br>
                ${departureDisplay}
            </div>

            <div style="
                margin-top: 10px;
                font-size: 13px;
                color: #666;
            ">
                ℹ️ Departure time includes a
                ${safetyBuffer}-minute safety buffer.
            </div>

        </div>

    `;
}


// =====================================================
// ROUTE FEATURE
// =====================================================

function createLineFeature(
    points,
    routeIndex
) {

    return {

        type:
            "Feature",

        properties: {

            routeIndex:
                routeIndex

        },

        geometry: {

            type:
                "LineString",

            coordinates:

                points.map(
                    point => [

                        point[1],

                        point[0]

                    ]
                )

        }

    };

}


// =====================================================
// DRAW ROUTES
// =====================================================

function drawRoutes(
    routes
) {

    if (
        !routeSourceReady
    ) {
        return;
    }

    availableRoutes = Array.isArray(routes) ? routes : [];
    if (selectedRouteIndex >= availableRoutes.length) selectedRouteIndex = 0;

    const features = [];


    routes.forEach(

        (
            route,
            index
        ) => {

            const points = [];


            route.legs.forEach(

                leg => {

                    leg.points.forEach(

                        point => {

                            points.push([

                                point.latitude,

                                point.longitude

                            ]);

                        }

                    );

                }

            );


            if (
                points.length > 1
            ) {

                features.push(

                    createLineFeature(
                        points,
                        index
                    )

                );

            }

        }

    );


    const source =
        map.getSource(
            "routes-source"
        );


    if (source) {

        source.setData({

            type:
                "FeatureCollection",

            features:
                features

        });

        updateRouteLayerStyles();
    }

}


// =====================================================
// CLEAR ROUTES
// =====================================================

function clearRoutes() {

    availableRoutes = [];
    selectedRouteIndex = 0;

    const source =
        map.getSource(
            "routes-source"
        );


    if (source) {

        source.setData({

            type:
                "FeatureCollection",

            features: []

        });

    }

}


// =====================================================
// SELECTED ROUTE STYLING + SELECTION
// =====================================================

function updateRouteLayerStyles() {
    if (!map || !routeSourceReady) return;

    // The selected route is always the thick blue main route.
    if (map.getLayer("route-fastest")) {
        map.setFilter("route-fastest", [
            "==", ["get", "routeIndex"], selectedRouteIndex
        ]);
        map.setPaintProperty("route-fastest", "line-color", "#1565ff");
        map.setPaintProperty("route-fastest", "line-width", 7);
        map.setPaintProperty("route-fastest", "line-opacity", 0.98);
        map.setPaintProperty("route-fastest", "line-dasharray", [1, 0]);
    }

    // Every non-selected route remains visible as a secondary route.
    if (map.getLayer("route-alternate")) {
        map.setFilter("route-alternate", ["==", ["get", "routeIndex"], -999]);
    }

    if (map.getLayer("route-other")) {
        map.setFilter("route-other", [
            "all",
            [">=", ["get", "routeIndex"], 0],
            ["!=", ["get", "routeIndex"], selectedRouteIndex]
        ]);
        map.setPaintProperty("route-other", "line-color", "#f59e0b");
        map.setPaintProperty("route-other", "line-width", 4);
        map.setPaintProperty("route-other", "line-opacity", 0.75);
        map.setPaintProperty("route-other", "line-dasharray", [2, 2]);
    }
}

function selectRouteByNumber(routeNumber) {
    const index = Number(routeNumber) - 1;
    if (!Number.isInteger(index) || index < 0 || index >= availableRoutes.length) {
        console.warn("Selected route is not available:", routeNumber);
        return;
    }

    selectedRouteIndex = index;
    currentRoute = availableRoutes[index];
    updateRouteLayerStyles();

    const summary = currentRoute && currentRoute.summary;
    if (summary) {
        const seconds = Number(summary.travelTimeInSeconds) || 0;
        const travelTimeElement = document.getElementById("travelTime");
        if (travelTimeElement) travelTimeElement.textContent = formatTime(seconds);
        updateJourneyPlanning(seconds);

        const trafficStatus = document.getElementById("trafficStatus");
        const delay = Number(summary.trafficDelayInSeconds) || 0;
        if (trafficStatus) {
            trafficStatus.textContent = delay > 0
                ? `Selected Route ${routeNumber} — Traffic Delay: ${formatTime(delay)}`
                : `Selected Route ${routeNumber} — Route delay estimate: 0`;
            trafficStatus.style.color = delay > 0 ? "#b45309" : "#1565ff";
        }
    }

    // Update the selected card and main-route label without losing recommendation badges.
    document.querySelectorAll("[data-route-number]").forEach(card => {
        const isSelected = Number(card.dataset.routeNumber) === Number(routeNumber);
        card.style.outline = isSelected ? "3px solid #1565ff" : "none";
        card.style.outlineOffset = isSelected ? "2px" : "0";
    });

    const message = document.getElementById("routeMessage");
    if (message) {
        message.insertAdjacentHTML("beforeend", `<br>✅ Route ${routeNumber} selected as your main route.`);
    }
}

// Allow inline card buttons to call this function from the HTML.
window.selectRouteByNumber = selectRouteByNumber;


// =====================================================
// CREATE CIRCLE
// =====================================================

function createCircleGeoJSON(

    latitude,

    longitude,

    radiusKm,

    steps = 96

) {

    const coordinates = [];


    const earthRadius =
        6371;


    const lat1 =
        latitude *
        Math.PI /
        180;


    const lon1 =
        longitude *
        Math.PI /
        180;


    const angularDistance =
        radiusKm /
        earthRadius;


    for (

        let i = 0;

        i <= steps;

        i++

    ) {

        const bearing =

            2 *
            Math.PI *
            i /
            steps;


        const lat2 =

            Math.asin(

                Math.sin(lat1) *

                Math.cos(
                    angularDistance
                )

                +

                Math.cos(lat1) *

                Math.sin(
                    angularDistance
                ) *

                Math.cos(
                    bearing
                )

            );


        const lon2 =

            lon1 +

            Math.atan2(

                Math.sin(bearing) *

                Math.sin(
                    angularDistance
                ) *

                Math.cos(lat1),

                Math.cos(
                    angularDistance
                )

                -

                Math.sin(lat1) *

                Math.sin(lat2)

            );


        coordinates.push([

            lon2 *
            180 /
            Math.PI,

            lat2 *
            180 /
            Math.PI

        ]);

    }


    return {

        type:
            "Feature",

        geometry: {

            type:
                "Polygon",

            coordinates: [
                coordinates
            ]

        },

        properties: {}

    };

}


// =====================================================
// UPDATE 5 KM CIRCLE
// =====================================================

function updateMonitoringCircle(

    latitude,

    longitude

) {

    const source =
        map.getSource(
            "monitoring-source"
        );


    if (!source) {
        return;
    }


    source.setData({

        type:
            "FeatureCollection",

        features: [

            createCircleGeoJSON(

                latitude,

                longitude,

                5

            )

        ]

    });

}


// =====================================================
// MANUAL TRAFFIC SCANNER
// =====================================================

function setManualScanStatus(message) {
    const status = document.getElementById("manualScanStatus");
    if (status) status.textContent = message;
}

function updateManualScanRadiusLabel() {
    const label = document.getElementById("manualScanRadiusValue");
    if (label) label.textContent = `${manualScanRadiusKm} km`;
}

function updateManualScanCircle() {
    const source = map && map.getSource("manual-scan-source");
    if (!source || !manualScanCenter) return;

    source.setData({
        type: "FeatureCollection",
        features: [
            createCircleGeoJSON(
                manualScanCenter.latitude,
                manualScanCenter.longitude,
                manualScanRadiusKm
            ),
            {
                type: "Feature",
                properties: { kind: "center" },
                geometry: {
                    type: "Point",
                    coordinates: [
                        manualScanCenter.longitude,
                        manualScanCenter.latitude
                    ]
                }
            }
        ]
    });
}

function setManualScanCenter(latitude, longitude, moveMap = false) {
    manualScanCenter = {
        latitude: Number(latitude),
        longitude: Number(longitude)
    };

    updateManualScanCircle();

    if (moveMap) {
        map.flyTo({
            center: [manualScanCenter.longitude, manualScanCenter.latitude],
            zoom: Math.max(map.getZoom(), 13),
            duration: 500
        });
    }
}

function manualSampleLabel(direction) {
    const parts = String(direction.direction || "").toUpperCase().split("-");
    const compass = parts[0] || "ROAD";
    const band = parts[1] || "";
    const compassLabels = {
        NORTH: "North", EAST: "East", SOUTH: "South", WEST: "West",
        NORTHEAST: "North-east", NORTHWEST: "North-west",
        SOUTHEAST: "South-east", SOUTHWEST: "South-west"
    };
    const bandLabels = {
        INNER: "Nearby roads",
        MIDDLE: "Mid-range roads",
        OUTER: "Farther roads"
    };
    return `${compassLabels[compass] || compass} · ${bandLabels[band] || "Sampled road"}`;
}

function manualTrafficLevelLabel(level) {
    const labels = {
        NORMAL: "🟢 Normal traffic",
        MODERATE: "🟠 Moderate traffic",
        HEAVY: "🔴 Heavy traffic",
        UNKNOWN: "⚪ Traffic data unavailable"
    };
    return labels[String(level || "UNKNOWN").toUpperCase()] || "⚪ Traffic status unknown";
}

function formatManualTrafficDirection(direction) {
    const label = escapeManualHtml(manualSampleLabel(direction));
    if (!direction.available || direction.level === "UNKNOWN") {
        return `<li class="manual-scan-result-item unavailable"><strong>${label}:</strong> ⚪ Traffic data unavailable${direction.error ? ` (${escapeManualHtml(direction.error)})` : ""}</li>`;
    }

    const labels = {
        NORMAL: "🟢 Normal",
        MODERATE: "🟠 Moderate",
        HEAVY: "🔴 Heavy"
    };
    const level = labels[direction.level] || "⚪ Unknown";
    const closure = direction.roadClosure ? " — ⚠️ Road closure reported by traffic data" : "";
    const confidence = direction.confidence == null
        ? ""
        : `; confidence ${Math.round(Number(direction.confidence) * 100)}%`;

    if (Number.isFinite(Number(direction.currentSpeedKmph)) &&
        Number.isFinite(Number(direction.freeFlowSpeedKmph))) {
        const reduction = direction.speedReductionPercent == null
            ? "not available"
            : `${direction.speedReductionPercent}%`;
        return `<li class="manual-scan-result-item"><strong>${label}:</strong> ${level} — current speed ${Number(direction.currentSpeedKmph).toFixed(0)} km/h vs usual free-flow ${Number(direction.freeFlowSpeedKmph).toFixed(0)} km/h; speed reduction ${reduction}${confidence}${closure}</li>`;
    }

    const delay = Number(direction.delayMinutes ?? (direction.delayInSeconds || 0) / 60);
    return `<li class="manual-scan-result-item"><strong>${label}:</strong> ${level} — reported route delay ${delay.toFixed(1)} min${closure}</li>`;
}
function escapeManualHtml(value) {
    return String(value).replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

async function scanManualTraffic() {
    if (manualScanInProgress) return;

    if (!manualScanCenter) {
        setManualScanStatus("Choose a location on the map before scanning.");
        return;
    }

    manualScanInProgress = true;
    const button = document.getElementById("scanTrafficHere");
    const results = document.getElementById("manualScanResults");

    if (button) button.disabled = true;
    if (results) results.textContent = "Scanning the selected area. Please wait...";
    setManualScanStatus(
        `Checking traffic within ${manualScanRadiusKm} km of the selected location...`
    );

    try {
        const params = new URLSearchParams({
            latitude: String(manualScanCenter.latitude),
            longitude: String(manualScanCenter.longitude),
            radiusKm: String(manualScanRadiusKm)
        });

        const response = await fetch(`${BACKEND_URL}/api/traffic-scan?${params.toString()}`);
        const data = await response.json();

        if (!response.ok || data.status !== "success") {
            throw new Error(data.message || data.error || `Traffic scan failed (HTTP ${response.status}).`);
        }

        const monitoring = data.monitoring || {};
        const directions = Array.isArray(monitoring.directions) ? monitoring.directions : [];
        const availableCount = directions.filter(item => item.available && item.level !== "UNKNOWN").length;
        const totalSamples = Number(monitoring.totalSamples || data.traffic?.totalSamples || directions.length || 0);
        const overallLevel = String(data.traffic?.level || "UNKNOWN").toUpperCase();
        const heavyCount = directions.filter(item => item.available && item.level === "HEAVY").length;
        const moderateCount = directions.filter(item => item.available && item.level === "MODERATE").length;
        const closedCount = directions.filter(item => item.available && item.roadClosure === true).length;

        if (results) {
            const directionList = directions.length
                ? `<ul class="manual-scan-results-list">${directions.map(formatManualTrafficDirection).join("")}</ul>`
                : "<p>No road-sample results were returned.</p>";
            const statusSummary = overallLevel === "UNKNOWN"
                ? "No reliable overall status could be calculated from the available samples."
                : overallLevel === "HEAVY"
                    ? `At least one sampled road has heavy traffic${closedCount ? ` or a reported road closure (${closedCount})` : ""}.`
                    : overallLevel === "MODERATE"
                        ? "Moderate traffic was found on at least one sampled road."
                        : "No heavy or moderate conditions were found in the available samples; this does not guarantee every road is clear.";

            results.innerHTML = `
                <div class="manual-scan-summary">
                    <strong>📡 Manual Traffic Scan</strong>
                    <p><strong>Overall sampled status:</strong> ${escapeManualHtml(manualTrafficLevelLabel(overallLevel))}</p>
                    <p>${escapeManualHtml(statusSummary)}</p>
                    <div class="manual-scan-counts">
                        <span><strong>${availableCount}/${totalSamples}</strong><small>Road samples with data</small></span>
                        <span><strong>${heavyCount}</strong><small>Heavy samples</small></span>
                        <span><strong>${moderateCount}</strong><small>Moderate samples</small></span>
                    </div>
                    <p><strong>Scan centre:</strong> ${manualScanCenter.latitude.toFixed(5)}, ${manualScanCenter.longitude.toFixed(5)}</p>
                    <p><strong>Area radius:</strong> ${manualScanRadiusKm} km</p>
                </div>
                <details class="manual-scan-details" open>
                    <summary>View road samples (${directions.length})</summary>
                    ${directionList}
                </details>
                <p class="manual-scan-disclaimer"><small>${escapeManualHtml(data.message || "Traffic is estimated from sampled road segments, not every road in the circle.")}</small></p>
            `;
        }

        setManualScanStatus(
            availableCount === totalSamples && totalSamples > 0
                ? `Scan complete: live traffic data received for all ${totalSamples} sampled road segments.`
                : availableCount > 0
                    ? `Partial scan: live data received for ${availableCount} of ${totalSamples} sampled road segments. Missing samples are not treated as normal.`
                    : "Traffic data unavailable. Wait for the API cooldown or check the TomTom key/quota."
        );
    } catch (error) {
        console.error("Manual traffic scan error:", error);
        if (results) {
            results.textContent = `Traffic scan failed: ${error.message}`;
        }
        setManualScanStatus("Could not complete the scan. Check the backend and TomTom API configuration.");
    } finally {
        manualScanInProgress = false;
        if (button) button.disabled = false;
    }
}

function setupManualTrafficScanner() {
    const radiusSlider = document.getElementById("manualScanRadius");
    const chooseButton = document.getElementById("chooseScanLocation");
    const scanButton = document.getElementById("scanTrafficHere");
    const resetButton = document.getElementById("resetScanLocation");

    if (radiusSlider) {
        radiusSlider.addEventListener("input", () => {
            manualScanRadiusKm = Math.max(1, Math.min(20, Number(radiusSlider.value) || 5));
            updateManualScanRadiusLabel();
            updateManualScanCircle();
        });
        manualScanRadiusKm = Number(radiusSlider.value) || 5;
        updateManualScanRadiusLabel();
    }

    if (chooseButton) {
        chooseButton.addEventListener("click", () => {
            manualScanChooseMode = true;
            if (map) map.getCanvas().style.cursor = "crosshair";
            setManualScanStatus("Location selection enabled. Click a point on the map.");
        });
    }

    if (scanButton) {
        scanButton.addEventListener("click", scanManualTraffic);
    }

    if (resetButton) {
        resetButton.addEventListener("click", () => {
            manualScanCenter = null;
            manualScanChooseMode = false;
            manualScanDragging = false;
            manualScanDragOffset = null;

            const source = map && map.getSource("manual-scan-source");
            if (source) {
                source.setData({
                    type: "FeatureCollection",
                    features: []
                });
            }

            if (map) map.getCanvas().style.cursor = "";
            const results = document.getElementById("manualScanResults");
            if (results) results.textContent = "No manual scan results yet.";
            setManualScanStatus("Manual scan reset. Choose a new location on the map.");
        });
    }

    // Click map to place the manual scan circle.
    map.on("click", event => {
        if (!manualScanChooseMode) return;

        setManualScanCenter(event.lngLat.lat, event.lngLat.lng);
        manualScanChooseMode = false;
        map.getCanvas().style.cursor = "";
        setManualScanStatus(
            `Selected location: ${manualScanCenter.latitude.toFixed(5)}, ${manualScanCenter.longitude.toFixed(5)}. Adjust radius or scan traffic.`
        );
    });

    // Drag the manual scan circle itself without moving the GPS circle.
    const startDragging = event => {
        if (!manualScanCenter || manualScanChooseMode) return;
        if (event.preventDefault) event.preventDefault();

        manualScanDragging = true;
        manualScanDragOffset = {
            latitude: manualScanCenter.latitude - event.lngLat.lat,
            longitude: manualScanCenter.longitude - event.lngLat.lng
        };

        map.dragPan.disable();
        map.getCanvas().style.cursor = "grabbing";
    };

    const dragCircle = event => {
        if (!manualScanDragging || !manualScanDragOffset) return;

        setManualScanCenter(
            event.lngLat.lat + manualScanDragOffset.latitude,
            event.lngLat.lng + manualScanDragOffset.longitude
        );
    };

    const stopDragging = () => {
        if (!manualScanDragging) return;
        manualScanDragging = false;
        manualScanDragOffset = null;
        map.dragPan.enable();
        map.getCanvas().style.cursor = manualScanChooseMode ? "crosshair" : "";
        setManualScanStatus("Scan circle moved. Select “Scan Traffic Here” to refresh results.");
    };

    map.on("mousedown", "manual-scan-fill", startDragging);
    map.on("mousemove", dragCircle);
    map.on("mouseup", stopDragging);

    map.on("touchstart", "manual-scan-fill", startDragging);
    map.on("touchmove", dragCircle);
    map.on("touchend", stopDragging);

    map.on("mouseenter", "manual-scan-fill", () => {
        if (!manualScanChooseMode && !manualScanDragging) {
            map.getCanvas().style.cursor = "grab";
        }
    });

    map.on("mouseleave", "manual-scan-fill", () => {
        if (!manualScanDragging) {
            map.getCanvas().style.cursor = manualScanChooseMode ? "crosshair" : "";
        }
    });
}


// =====================================================
// UPDATE GPS ACCURACY
// =====================================================

function updateAccuracyCircle(

    latitude,

    longitude,

    accuracy

) {

    const source =
        map.getSource(
            "accuracy-source"
        );


    if (!source) {
        return;
    }


    const radiusKm =

        Math.max(

            Number(accuracy) || 20,

            10

        ) / 1000;


    source.setData({

        type:
            "FeatureCollection",

        features: [

            createCircleGeoJSON(

                latitude,

                longitude,

                radiusKm,

                64

            )

        ]

    });

}


// =====================================================
// DETECT MY LOCATION
// =====================================================

function detectMyLocation() {

    requestNotificationPermission();

    const locationStatus =

        document.getElementById(
            "locationStatus"
        );


    if (
        !navigator.geolocation
    ) {

        if (locationStatus) {

            locationStatus.innerHTML =
                "❌ Geolocation is not supported.";

        }

        return;

    }


    if (locationStatus) {

        locationStatus.innerHTML =
            "📍 Detecting your location...";

    }


    navigator.geolocation.getCurrentPosition(

        async function(position) {

            const latitude =
                position.coords.latitude;


            const longitude =
                position.coords.longitude;


            const accuracy =
                position.coords.accuracy;


            const speed =
                position.coords.speed;


            console.log(

                "📍 GPS LOCATION",

                latitude,

                longitude,

                "Accuracy:",

                accuracy

            );


            currentPosition = {

                latitude:
                    latitude,

                longitude:
                    longitude,

                accuracy:
                    accuracy,

                speed:
                    speed

            };


            window.detectedLocation = {

                lat:
                    latitude,

                lon:
                    longitude

            };
// =====================================================
// START CONTINUOUS GPS TRACKING
// =====================================================

if (gpsWatchId === null) {

    gpsWatchId =
        navigator.geolocation.watchPosition(

            updateUserLocation,

            handleLocationError,

            {
                enableHighAccuracy: true,

                maximumAge: 1000,

                timeout: 10000
            }

        );

    console.log(
        "📍 Continuous GPS tracking started."
    );
}

            const fromInput =
                document.getElementById(
                    "fromLocation"
                );


            if (fromInput) {

                fromInput.value =
                    "My Current Location";

            }


            currentFromLocation =
                "My Current Location";


            updateUserLocationMarker(

                latitude,

                longitude

            );


            updateMonitoringCircle(

                latitude,

                longitude

            );


            updateAccuracyCircle(

                latitude,

                longitude,

                accuracy

            );


            map.flyTo({

                center: [

                    longitude,

                    latitude

                ],

                zoom:
                    17,

                speed:
                    1.2,

                curve:
                    1.2,

                essential:
                    true

            });


            if (locationStatus) {

                locationStatus.innerHTML = `

                    🟢 Location detected

                    <br>

                    📍 Accuracy:

                    ${Math.round(
                        accuracy
                    )}

                    meters

                    <br>

                    🌐 Latitude:

                    ${latitude.toFixed(6)}

                    <br>

                    🌐 Longitude:

                    ${longitude.toFixed(6)}

                `;

                locationStatus.style.color =
                    "green";

            }


            await sendLocationToBackend(

                latitude,

                longitude,

                accuracy,

                speed

            );

        },


        function(error) {

            console.error(

                "GPS Error:",

                error

            );


            if (!locationStatus) {
                return;
            }


            if (
                error.code === 1
            ) {

                locationStatus.innerHTML =
                    "❌ Location permission denied.";

            }

            else if (
                error.code === 2
            ) {

                locationStatus.innerHTML =
                    "❌ Location unavailable.";

            }

            else if (
                error.code === 3
            ) {

                locationStatus.innerHTML =
                    "❌ Location request timed out.";

            }

            else {

                locationStatus.innerHTML =
                    "❌ Unable to detect location.";

            }


            locationStatus.style.color =
                "red";

        },


        {

            enableHighAccuracy:
                true,

            timeout:
                30000,

            maximumAge: 5000
                

        }

    );

}


// =====================================================
// SEND GPS TO BACKEND
// =====================================================

async function sendLocationToBackend(

    latitude,

    longitude,

    accuracy,

    speed

) {

    try {

        const response =

            await fetch(

                `${BACKEND_URL}/api/location`,

                {

                    method:
                        "POST",

                    headers: {

                        "Content-Type":
                            "application/json"

                    },

                    body:

                        JSON.stringify({

                            latitude:
                                latitude,

                            longitude:
                                longitude,

                            accuracy:
                                accuracy,

                            speed:
                                speed

                        })

                }

            );


        const data =
            await response.json();


        console.log(

            "📡 Backend location:",

            data

        );

    }

    catch (error) {

        console.error(

            "❌ Backend GPS error:",

            error

        );

    }

}


// =====================================================
// TOMTOM ROUTES
// =====================================================

async function getTomTomRoutes(

    fromLat,

    fromLon,

    toLat,

    toLon

) {

    const url =

        `${BACKEND_URL}/api/tomtom-route` +

        `?fromLat=${encodeURIComponent(
            fromLat
        )}` +

        `&fromLon=${encodeURIComponent(
            fromLon
        )}` +

        `&toLat=${encodeURIComponent(
            toLat
        )}` +

        `&toLon=${encodeURIComponent(
            toLon
        )}`;


    const response =
        await fetch(url);


    const data =
        await response.json();


    if (!response.ok) {

        throw new Error(

            data.message ||

            "TomTom Routing API failed."

        );

    }


    if (

        data.status !==
            "success" ||

        !data.data ||

        !data.data.routes

    ) {

        throw new Error(

            "No routes received from TomTom."

        );

    }


    return data.data.routes;

}


// =====================================================
// ALTERNATE ROUTE
// =====================================================

async function getAlternateRouteRecommendation(

    fromLat,

    fromLon,

    toLat,

    toLon

) {

    try {

        const url =

            `${BACKEND_URL}/api/alternate-route` +

            `?fromLat=${encodeURIComponent(
                fromLat
            )}` +

            `&fromLon=${encodeURIComponent(
                fromLon
            )}` +

            `&toLat=${encodeURIComponent(
                toLat
            )}` +

            `&toLon=${encodeURIComponent(
                toLon
            )}`;


        const response =
            await fetch(url);


        const data =
            await response.json();


        if (!response.ok) {
            return null;
        }


        return data;

    }

    catch (error) {

        console.error(

            "Alternate route error:",

            error

        );

        return null;

    }

}

// =====================================================
// DYNAMIC JOURNEY ROUTE UPDATE
// =====================================================

async function updateJourneyRoute(
    latitude,
    longitude
) {

    if (!journeyActive) {
        return;
    }


    if (!currentDestinationCoordinates) {
        return;
    }


    if (dynamicRouteChecking) {
        return;
    }


    const now =
        Date.now();


    // Recalculate only once every 15 seconds
    if (
        now -
        lastDynamicRouteCheck <
        15000
    ) {

        return;
    }


    lastDynamicRouteCheck =
        now;


    dynamicRouteChecking =
        true;


    try {

        console.log(
            "🔄 Recalculating journey route..."
        );


        const routes =
            await getTomTomRoutes(

                latitude,

                longitude,

                currentDestinationCoordinates.lat,

                currentDestinationCoordinates.lon

            );


        if (
            !routes ||
            routes.length === 0
        ) {

            console.warn(
                "⚠️ No updated routes found."
            );

            return;
        }


        // Update routes on map
        drawRoutes(
            routes
        );


        // Find fastest route
        let fastestIndex =
            0;


        routes.forEach(
            function (
                route,
                index
            ) {

                const currentTime =
                    Number(
                        route.summary
                            .travelTimeInSeconds
                    ) || 0;


                const fastestTime =
                    Number(
                        routes[
                            fastestIndex
                        ]
                            .summary
                            .travelTimeInSeconds
                    ) || 0;


                if (
                    currentTime <
                    fastestTime
                ) {

                    fastestIndex =
                        index;

                }

            }
        );


        // Keep the user's selected route after live recalculation when that route still exists.
        if (selectedRouteIndex >= routes.length) {
            selectedRouteIndex = fastestIndex;
        }

        currentRoute = routes[selectedRouteIndex];
        updateRouteLayerStyles();


        // Get fresh alternate-route recommendation
        const alternateData =
            await getAlternateRouteRecommendation(

                latitude,

                longitude,

                currentDestinationCoordinates.lat,

                currentDestinationCoordinates.lon

            );


        if (
            alternateData
        ) {

            displayRouteRecommendation(
                alternateData
            );

        }


        const summary =
            currentRoute.summary;

        updateJourneyPlanning(
            summary.travelTimeInSeconds
        );


        const travelTime =
            document.getElementById(
                "travelTime"
            );


        if (travelTime) {

            travelTime.innerHTML =
                formatTime(
                    summary.travelTimeInSeconds
                );

        }


        const trafficDelay =
            Number(
                summary.trafficDelayInSeconds
            ) || 0;


        const trafficStatus =
            document.getElementById(
                "trafficStatus"
            );


        if (trafficStatus) {

            if (
                trafficDelay > 0
            ) {

                trafficStatus.innerHTML =

                    `🔄 Route updated<br>` +
                    `🚦 Traffic Delay: ` +
                    `${formatTime(
                        trafficDelay
                    )}`;

                trafficStatus.style.color =
                    "orange";

            }

            else {

                trafficStatus.innerHTML =

                    "🔄 Route updated<br>" +
                    "🟢 No significant traffic delay";

                trafficStatus.style.color =
                    "green";

            }

        }


        const routeMessage =
            document.getElementById(
                "routeMessage"
            );


        if (routeMessage) {

            routeMessage.innerHTML = `

                🚗 <strong>
                    Journey Active
                </strong>

                <br><br>

                🔄 Route checked automatically

                <br>

                🛣️
                ${routes.length}
                routes available

                <br>

                ⏱️ Current travel time:
                ${formatTime(
                    summary.travelTimeInSeconds
                )}

            `;

        }


        console.log(
            "✅ Journey route updated.",
            routes
        );

    }

    catch (error) {

        console.error(
            "❌ Dynamic route update error:",
            error
        );

    }

    finally {

        dynamicRouteChecking =
            false;

    }

}


// =====================================================
// DISPLAY RECOMMENDATION
// =====================================================

function displayRouteRecommendation(
    data
) {

    const element =
        document.getElementById(
            "recommendationMessage"
        );


    if (!element) {
        return;
    }


    if (
        !data ||
        !data.recommendation ||
        !data.routes ||
        data.routes.length === 0
    ) {

        element.innerHTML = `
            <div style="
                padding: 15px;
                text-align: center;
                color: #666;
            ">
                ℹ️ Route comparison data is not available.
            </div>
        `;

        return;

    }


    const recommendation =
        data.recommendation;


    const routes =
        data.routes;


    let html = `

        <div style="
            font-size: 20px;
            font-weight: 700;
            margin-bottom: 18px;
        ">
            🛣️ Route Comparison
        </div>

    `;


    routes.forEach(
        function (route) {

            const isRecommended =
                route.routeNumber ===
                recommendation.routeNumber;


            const isCurrent =
                route.routeNumber === 1;

            const isSelected =
                Number(route.routeNumber) === (selectedRouteIndex + 1);

            const routeTitle =
                isSelected
                    ? "Selected Main Route"
                    : (isCurrent ? "Fastest / Primary Option" : "Alternative Route");


            const selectedBadge =
                isSelected
                    ? `<span style="display:inline-block;margin-left:8px;padding:4px 8px;border-radius:20px;background:#dbeafe;color:#1d4ed8;font-size:12px;font-weight:700;">✓ SELECTED MAIN ROUTE</span>`
                    : "";

            const recommendationBadge =
                isRecommended
                    ? `
                        <span style="
                            display: inline-block;
                            margin-left: 8px;
                            padding: 4px 8px;
                            border-radius: 20px;
                            background: #dcfce7;
                            color: #166534;
                            font-size: 12px;
                            font-weight: 700;
                        ">
                            ⭐ RECOMMENDED
                        </span>
                    `
                    : "";


            html += `

                <div
                    data-route-number="${route.routeNumber}"
                    role="button"
                    tabindex="0"
                    aria-label="Select Route ${route.routeNumber} as the main route"
                    onclick="selectRouteByNumber(${route.routeNumber})"
                    onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();selectRouteByNumber(${route.routeNumber});}"
                    style="
                    margin-bottom: 14px;
                    padding: 15px;
                    border: 2px solid ${
                        isSelected ? "#1565ff" : (isRecommended ? "#16a34a" : "#e5e7eb")
                    };
                    border-radius: 12px;
                    background: ${
                        isSelected ? "#eff6ff" : (isRecommended ? "#f0fdf4" : "#ffffff")
                    };
                    cursor: pointer;
                    transition: outline 0.15s ease, border-color 0.15s ease;
                ">

                    <div style="
                        font-size: 17px;
                        font-weight: 700;
                        margin-bottom: 12px;
                    ">

                        🛣️ Route ${route.routeNumber}

                        <span style="
                            font-weight: 500;
                            color: #666;
                            font-size: 14px;
                        ">
                            — ${routeTitle}
                        </span>

                        ${recommendationBadge}
                        ${selectedBadge}

                    </div>


                    <div style="
                        display: grid;
                        grid-template-columns:
                            repeat(
                                auto-fit,
                                minmax(120px, 1fr)
                            );
                        gap: 10px;
                    ">

                        <div style="
                            padding: 10px;
                            background: #f8fafc;
                            border-radius: 8px;
                        ">

                            📏
                            <strong>
                                ${route.distanceKm} km
                            </strong>

                            <br>

                            <span style="
                                font-size: 12px;
                                color: #666;
                            ">
                                Distance
                            </span>

                        </div>


                        <div style="
                            padding: 10px;
                            background: #f8fafc;
                            border-radius: 8px;
                        ">

                            ⏱️
                            <strong>
                                ${route.travelTimeMinutes} min
                            </strong>

                            <br>

                            <span style="
                                font-size: 12px;
                                color: #666;
                            ">
                                Travel Time
                            </span>

                        </div>


                        <div style="
                            padding: 10px;
                            background: #f8fafc;
                            border-radius: 8px;
                        ">

                            🚦
                            <strong>
                                ${route.trafficDelayMinutes} min
                            </strong>

                            <br>

                            <span style="
                                font-size: 12px;
                                color: #666;
                            ">
                                Traffic Delay
                            </span>

                        </div>

                    </div>

                </div>

            `;

        }
    );


    html += `

        <div style="
            margin-top: 18px;
            padding: 16px;
            border-radius: 12px;
            background: ${
                recommendation.isAlternateBetter
                    ? "#fff7ed"
                    : "#f0fdf4"
            };
            border: 1px solid ${
                recommendation.isAlternateBetter
                    ? "#fdba74"
                    : "#86efac"
            };
        ">

            ${
                recommendation.isAlternateBetter

                    ? `

                        <div style="
                            font-size: 18px;
                            font-weight: 700;
                            color: #c2410c;
                            margin-bottom: 8px;
                        ">
                            🔄 Alternate Route Recommended
                        </div>

                        <div>
                            🛣️ Switch to
                            <strong>
                                Route ${recommendation.routeNumber}
                            </strong>
                        </div>

                        <div style="
                            margin-top: 5px;
                        ">
                            ⏱️ You can save approximately
                            <strong>
                                ${recommendation.timeSavedMinutes} minutes
                            </strong>
                        </div>

                    `

                    : `

                        <div style="
                            font-size: 18px;
                            font-weight: 700;
                            color: #166534;
                            margin-bottom: 8px;
                        ">
                            🟢 Current Route is Recommended
                        </div>

                        <div>
                            🛣️ Route
                            <strong>
                                ${recommendation.routeNumber}
                            </strong>
                            is currently the fastest available route.
                        </div>

                        <div style="
                            margin-top: 5px;
                            color: #555;
                        ">
                            ℹ️ No faster alternate route is
                            currently available.
                        </div>

                    `
            }

        </div>

    `;


    element.innerHTML =
        html;

}

// =====================================================
// FIND ROUTE
// =====================================================

async function findRoute() {

    const fromLocation =
        document.getElementById(
            "fromLocation"
        ).value.trim();


    const destination =
        document.getElementById(
            "destination"
        ).value.trim();


    const routeMessage =
        document.getElementById(
            "routeMessage"
        );


    const trafficStatus =
        document.getElementById(
            "trafficStatus"
        );


    const travelTime =
        document.getElementById(
            "travelTime"
        );


    const alertMessage =
        document.getElementById(
            "alertMessage"
        );


    if (

        !fromLocation ||

        !destination

    ) {

        routeMessage.innerHTML =
            "⚠️ Please enter both locations.";

        return;

    }


    try {

        routeMessage.innerHTML =
            "🔄 Finding route...";


        trafficStatus.innerHTML =
            "🔄 Checking traffic...";


        currentDestination =
            destination;


        let from;


        if (

            fromLocation ===
                "My Current Location" &&

            window.detectedLocation

        ) {

            const gpsAccuracy = Number(currentPosition?.accuracy);

            if (!Number.isFinite(gpsAccuracy) || gpsAccuracy > 5000) {
                routeMessage.innerHTML =
                    `⚠️ GPS accuracy is too poor (${Number.isFinite(gpsAccuracy) ? Math.round(gpsAccuracy) + " m" : "unknown"}). ` +
                    `Please enter your starting town/village manually (for example, Parkal, Warangal) and try again.`;
                return;
            }

            from = {

                lat:
                    window.detectedLocation.lat,

                lon:
                    window.detectedLocation.lon

            };

        }

        else {

            from =
                await geocodeLocation(
                    fromLocation
                );

        }


        // Use the selected start coordinates to disambiguate same-name villages.
        const to =
            await geocodeLocation(
                destination,
                from
            );
        currentDestinationCoordinates = {
            lat: to.lat,
            lon: to.lon
        };


        clearRoutes();


        const routes =
            await getTomTomRoutes(

                from.lat,

                from.lon,

                to.lat,

                to.lon

            );


        drawRoutes(
            routes
        );


        let fastestIndex =
            0;


        routes.forEach(

            (
                route,
                index
            ) => {

                const currentTime =

                    route.summary
                        .travelTimeInSeconds;


                const fastestTime =

                    routes[
                        fastestIndex
                    ]
                        .summary
                        .travelTimeInSeconds;


                if (
                    currentTime <
                    fastestTime
                ) {

                    fastestIndex =
                        index;

                }

            }

        );


        const fastest =
            routes[
                fastestIndex
            ];

        // Initially select the fastest route as the main route.
        selectedRouteIndex = fastestIndex;
        updateRouteLayerStyles();

        currentRoute =
            fastest;


        const summary =
            fastest.summary;
        updateJourneyPlanning(
            summary.travelTimeInSeconds
        );

        if (travelTime) {

            travelTime.innerHTML =

                formatTime(

                    summary
                        .travelTimeInSeconds

                );

        }


        const trafficDelay =

            Number(
                summary
                    .trafficDelayInSeconds
            ) || 0;


        if (
            trafficDelay > 0
        ) {

            trafficStatus.innerHTML =

                `🔴 Traffic Delay: ` +

                `${formatTime(
                    trafficDelay
                )}`;


            trafficStatus.style.color =
                "red";

        }

        else {

            trafficStatus.innerHTML =

                "🟢 No significant traffic delay detected";


            trafficStatus.style.color =
                "green";

        }


        if (alertMessage) {

            if (
                trafficDelay >= 300
            ) {

                alertMessage.innerHTML =

                    `🚨 Heavy traffic detected.<br>
                    Expected delay:
                    ${formatTime(
                        trafficDelay
                    )}`;

            }

            else if (
                trafficDelay > 0
            ) {

                alertMessage.innerHTML =

                    `⚠️ Traffic delay detected:<br>
                    ${formatTime(
                        trafficDelay
                    )}`;

            }

            else {

                alertMessage.innerHTML =
                    "🟢 No significant traffic alert.";

            }

        }


        const alternateData =

            await getAlternateRouteRecommendation(

                from.lat,

                from.lon,

                to.lat,

                to.lon

            );


        if (
            alternateData
        ) {

            displayRouteRecommendation(

                alternateData

            );

        }


        fitRoutesOnMap(
            routes
        );


        routeMessage.innerHTML =

            `✅ ${routes.length} routes found successfully.`;


        addStartJourneyButton();

    }


    catch (error) {

        console.error(
            error
        );


        routeMessage.innerHTML =

            `❌ ${error.message}`;

    }

}


// =====================================================
// FIT ROUTES
// =====================================================

function fitRoutesOnMap(
    routes
) {

    const coordinates = [];


    routes.forEach(

        route => {

            route.legs.forEach(

                leg => {

                    leg.points.forEach(

                        point => {

                            coordinates.push([

                                point.longitude,

                                point.latitude

                            ]);

                        }

                    );

                }

            );

        }

    );


    if (
        coordinates.length === 0
    ) {

        return;

    }


    const bounds =
        new maplibregl.LngLatBounds();


    coordinates.forEach(

        coordinate => {

            bounds.extend(
                coordinate
            );

        }

    );


    map.fitBounds(

        bounds,

        {

            padding:
                60,

            duration:
                1000,

            maxZoom:
                16

        }

    );

}


// =====================================================
// START JOURNEY BUTTON
// =====================================================

function addStartJourneyButton() {

    let button =
        document.getElementById(
            "startJourneyBtn"
        );


    if (!button) {

        button =
            document.createElement(
                "button"
            );


        button.id =
            "startJourneyBtn";


        button.innerHTML =
            "🚗 Start Journey";


        button.className =
            "journey-button";


        const routeMessage =
            document.getElementById(
                "routeMessage"
            );


        if (
            routeMessage &&
            routeMessage.parentElement
        ) {

            routeMessage
                .parentElement
                .appendChild(
                    button
                );

        }

    }


    button.onclick =
        function () {

            if (
                journeyActive
            ) {

                stopJourney();

            }

            else {

                startJourney();

            }

        };

}


// =====================================================
// START JOURNEY
// =====================================================

function startJourney() {

    if (
        !navigator.geolocation
    ) {

        alert(
            "❌ Geolocation is not supported."
        );

        return;

    }


    if (
        !currentRoute
    ) {

        alert(
            "Please find a route first."
        );

        return;

    }


    journeyActive =
        true;


    const button =
        document.getElementById(
            "startJourneyBtn"
        );


    if (button) {

        button.innerHTML =
            "🛑 Stop Journey";

        button.classList.add(
            "stop"
        );

    }


    const routeMessage =
        document.getElementById(
            "routeMessage"
        );


    if (routeMessage) {

        routeMessage.innerHTML = `

            🚗 <strong>
                Journey Started
            </strong>

            <br><br>

            📍 Tracking your live location...

        `;

    }


    const trafficStatus =
        document.getElementById(
            "trafficStatus"
        );


    if (trafficStatus) {

        trafficStatus.innerHTML =
            "📍 GPS tracking active";

    }


    if (
        currentPosition
    ) {

        map.flyTo({

            center: [

                currentPosition.longitude,

                currentPosition.latitude

            ],

            zoom:
                17,

            duration:
                1000,

            essential:
                true

        });

    }


    gpsWatchId =

        navigator.geolocation.watchPosition(

            updateUserLocation,

            handleLocationError,

            {

                enableHighAccuracy:
                    true,

                maximumAge:
                    1000,

                timeout:
                    10000

            }

        );

    // Start a traffic check when the journey starts instead of waiting for
    // the background 3-minute timer. The backend will use cached route data
    // when available and return a clear cooldown message if TomTom is limited.
    if (trafficStatus) {
        trafficStatus.innerHTML = "📡 Getting live traffic status...";
    }
    setTimeout(() => {
        if (journeyActive) monitorTraffic();
    }, 2500);

}


// =====================================================
// LIVE GPS UPDATE
// =====================================================

function updateUserLocation(
    position
) {

    const latitude =
        position.coords.latitude;


    const longitude =
        position.coords.longitude;


    const accuracy =
        position.coords.accuracy;


    const speed =
        position.coords.speed;


    currentPosition = {

        latitude:
            latitude,

        longitude:
            longitude,

        accuracy:
            accuracy,

        speed:
            speed

    };


    window.detectedLocation = {

        lat:
            latitude,

        lon:
            longitude

    };


    updateUserLocationMarker(

        latitude,

        longitude

    );


    updateMonitoringCircle(

        latitude,

        longitude

    );


    updateAccuracyCircle(

        latitude,

        longitude,

        accuracy

    );


    sendLocationToBackend(

        latitude,

        longitude,

        accuracy,

        speed

    );
    updateJourneyRoute(
        latitude,
        longitude
    );


    if (
        journeyActive
    ) {

        map.easeTo({

            center: [

                longitude,

                latitude

            ],

            zoom:

                Math.max(

                    map.getZoom(),

                    16.5

                ),

            duration:
                600,

            essential:
                true

        });

    }


    let speedText =
        "Unavailable";


    if (

        speed !== null &&

        !isNaN(speed) &&

        speed >= 0

    ) {

        speedText =

            `${(

                speed * 3.6

            ).toFixed(1)} km/h`;

    }


    const routeMessage =
        document.getElementById(
            "routeMessage"
        );


    if (routeMessage) {

        routeMessage.innerHTML = `

            🚗 <strong>
                Journey Active
            </strong>

            <br><br>

            📍 Live Location Tracking

            <br>

            ⚡ Speed:

            ${speedText}

            <br>

            🎯 Destination:

            ${currentDestination}

            <br>

            📡 GPS Accuracy:

            ${Math.round(
                accuracy
            )} m

        `;

    }

}


// =====================================================
// TRAFFIC MONITOR
// =====================================================

let trafficMonitorInProgress = false;

async function monitorTraffic() {

    if (trafficMonitorInProgress) {
        return;
    }

    trafficMonitorInProgress = true;

    try {

        const response =

            await fetch(

                `${BACKEND_URL}/api/traffic-monitor`

            );


        if (
            !response.ok
        ) {
            let errorData = {};
            try { errorData = await response.json(); } catch (_) {}
            console.warn("Traffic monitor HTTP error:", response.status, errorData);

            const trafficStatus = document.getElementById("trafficStatus");
            if (trafficStatus && (response.status === 429 || errorData.status === "rate_limited")) {
                trafficStatus.innerHTML = `⏳ <strong>Traffic status temporarily unavailable</strong><br><br>${String(errorData.message || "TomTom rate limit reached. Please wait before retrying.").replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}`;
            }
            return;
        }


        const data =
            await response.json();


        console.log(
            "🚦 Traffic Monitor:",
            data
        );


        if (
            !data ||
            !data.traffic
        ) {

            return;

        }


        const traffic =
            data.traffic;


        const trafficStatus =
            document.getElementById(
                "trafficStatus"
            );


        const alertMessage =
            document.getElementById(
                "alertMessage"
            );


        if (!trafficStatus) {

            console.warn(
                "trafficStatus element not found."
            );

            return;

        }


        const delaySeconds =

            Number(
                traffic.delayInSeconds
            ) || 0;


        const delayMinutes =

            Math.round(
                delaySeconds / 60
            );


        const averageDelayMinutes =

            Number(
                traffic.averageDelayMinutes
            ) || 0;


        const worstDirection =

            traffic.worstDirection ||

            "Unknown";

        sendTrafficNotification(
            traffic.level,
            delayMinutes,
            worstDirection
        );


        const updatedTime =

            new Date()
                .toLocaleTimeString();


        // =================================================
        // NORMAL
        // =================================================

        if (

            traffic.level ===
            "NORMAL"

        ) {

            trafficStatus.innerHTML = `

                🟢 <strong>
                    Traffic is Normal
                </strong>

                <br><br>

                ⏱️ Current Delay:
                ${delayMinutes} min

                <br>

                📊 Average Delay:
                ${averageDelayMinutes} min

                <br>

                📍 Monitoring Radius:
                5 km

                <br>

                🧭 Worst Direction:
                ${worstDirection}

                <br>

                🕒 Updated:
                ${updatedTime}

            `;


            trafficStatus.style.color =
                "green";


            if (alertMessage) {

                alertMessage.innerHTML = `

                    🟢 <strong>
                        No significant traffic alert.
                    </strong>

                    <br><br>

                    Traffic conditions are currently
                    normal within the monitored area.

                `;

            }

        }


        // =================================================
        // MODERATE
        // =================================================

        else if (

            traffic.level ===
            "MODERATE"

        ) {

            trafficStatus.innerHTML = `

                🟠 <strong>
                    Moderate Traffic Detected
                </strong>

                <br><br>

                ⏱️ Current Delay:
                ${delayMinutes} min

                <br>

                📊 Average Delay:
                ${averageDelayMinutes} min

                <br>

                📍 Monitoring Radius:
                5 km

                <br>

                🧭 Worst Direction:
                ${worstDirection}

                <br>

                🕒 Updated:
                ${updatedTime}

            `;


            trafficStatus.style.color =
                "orange";


            if (alertMessage) {

                alertMessage.innerHTML = `

                    ⚠️ <strong>
                        TRAFFIC ALERT
                    </strong>

                    <br><br>

                    Moderate traffic detected
                    within the 5 km monitoring area.

                    <br><br>

                    🧭 Direction:
                    ${worstDirection}

                    <br>

                    ⏱️ Expected delay:
                    ${delayMinutes} min

                `;

            }

        }


        // =================================================
        // HEAVY
        // =================================================

        else if (

            traffic.level ===
            "HEAVY"

        ) {

            trafficStatus.innerHTML = `

                🔴 <strong>
                    Heavy Traffic Detected
                </strong>

                <br><br>

                ⏱️ Current Delay:
                ${delayMinutes} min

                <br>

                📊 Average Delay:
                ${averageDelayMinutes} min

                <br>

                📍 Monitoring Radius:
                5 km

                <br>

                🧭 Worst Direction:
                ${worstDirection}

                <br>

                🕒 Updated:
                ${updatedTime}

            `;


            trafficStatus.style.color =
                "red";


            if (alertMessage) {

                alertMessage.innerHTML = `

                    🚨 <strong>
                        HEAVY TRAFFIC ALERT
                    </strong>

                    <br><br>

                    Heavy traffic detected
                    within the 5 km monitoring area.

                    <br><br>

                    🧭 Worst affected direction:
                    ${worstDirection}

                    <br>

                    ⏱️ Expected delay:
                    ${delayMinutes} min

                    <br><br>

                    ⚠️ Consider checking
                    an alternate route.

                `;

            }

        }


        // =================================================
        // UNKNOWN
        // =================================================

        else {

            trafficStatus.innerHTML = `

                ⚠️ <strong>
                    Traffic Status Unavailable
                </strong>

                <br><br>

                📍 Monitoring Radius:
                5 km

                <br>

                🕒 Updated:
                ${updatedTime}

            `;


            trafficStatus.style.color =
                "#555";


            if (alertMessage) {

                alertMessage.innerHTML =
                    "⚠️ Unable to classify current traffic.";

            }

        }

    }

    catch (error) {

    console.error(
        "Traffic monitoring error:",
        error
    );

}
finally {

    trafficMonitorInProgress = false;

}

}


// =====================================================
// GPS ERROR
// =====================================================

function handleLocationError(
    error
) {

    console.error(

        "GPS Error:",

        error

    );


    let message =
        "Unable to get your location.";


    if (
        error.code === 1
    ) {

        message =
            "❌ Location permission denied.";

    }

    else if (
        error.code === 2
    ) {

        message =
            "❌ Location unavailable.";

    }

    else if (
        error.code === 3
    ) {

        message =
            "❌ Location request timed out.";

    }


    const routeMessage =
        document.getElementById(
            "routeMessage"
        );


    if (routeMessage) {

        routeMessage.innerHTML =
            message;

    }

}


// =====================================================
// STOP JOURNEY
// =====================================================

function stopJourney() {

    journeyActive =
        false;


    if (
        gpsWatchId !== null
    ) {

        navigator.geolocation.clearWatch(

            gpsWatchId

        );


        gpsWatchId =
            null;

    }


    const button =
        document.getElementById(
            "startJourneyBtn"
        );


    if (button) {

        button.innerHTML =
            "🚗 Start Journey";

        button.classList.remove(
            "stop"
        );

    }


    const routeMessage =
        document.getElementById(
            "routeMessage"
        );


    if (routeMessage) {

        routeMessage.innerHTML =
            "⏹️ Journey tracking stopped.";

    }


    const trafficStatus =
        document.getElementById(
            "trafficStatus"
        );


    if (trafficStatus) {

        trafficStatus.innerHTML =
            "🟡 Journey stopped";

    }

}


// =====================================================
// INITIALIZE
// =====================================================

initializeMap();

checkBackend();


// =====================================================
// BUTTONS
// =====================================================

const findRouteButton =
    document.getElementById(
        "findRoute"
    );


if (findRouteButton) {

    findRouteButton.addEventListener(

        "click",

        findRoute

    );

}


const detectLocationButton =
    document.getElementById(
        "detectLocation"
    );


if (detectLocationButton) {

    detectLocationButton.addEventListener(

        "click",

        detectMyLocation

    );

}


// =====================================================
// TRAFFIC CHECK EVERY 3 MINUTES (reduce upstream API rate-limit risk)
// =====================================================

setInterval(

    monitorTraffic,

    180000

);


setTimeout(

    monitorTraffic,

    1500

);

// =====================================================
// TARGET ARRIVAL TIME CHANGE LISTENER
// =====================================================

const targetArrivalTime =
    document.getElementById("targetArrivalTime");

if (targetArrivalTime) {

    targetArrivalTime.addEventListener(
        "change",
        function () {

            if (currentRoute) {

                updateJourneyPlanning(
                    currentRoute
                        .summary
                        .travelTimeInSeconds
                );

            }

        }
    );

}