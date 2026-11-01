// =====================================================
// TRAFFIC DIRECTION UI
// =====================================================

const TRAFFIC_DIRECTION_BACKEND = "";


// =====================================================
// GET ELEMENTS
// =====================================================

const compass =
    document.getElementById(
        "trafficCompass"
    );

const trafficSector =
    document.getElementById(
        "trafficSector"
    );

const trafficDirectionInfo =
    document.getElementById(
        "trafficDirectionInfo"
    );


// =====================================================
// NORMALIZE DIRECTION
// =====================================================

function normalizeDirection(direction) {

    if (!direction) {

        return null;

    }

    const value =
        String(direction)
            .trim()
            .toUpperCase();


    if (
        value === "NORTH" ||
        value === "N"
    ) {

        return "N";

    }


    if (
        value === "NORTH-EAST" ||
        value === "NORTHEAST" ||
        value === "NE"
    ) {

        return "NE";

    }


    if (
        value === "EAST" ||
        value === "E"
    ) {

        return "E";

    }


    if (
        value === "SOUTH-EAST" ||
        value === "SOUTHEAST" ||
        value === "SE"
    ) {

        return "SE";

    }


    if (
        value === "SOUTH" ||
        value === "S"
    ) {

        return "S";

    }


    if (
        value === "SOUTH-WEST" ||
        value === "SOUTHWEST" ||
        value === "SW"
    ) {

        return "SW";

    }


    if (
        value === "WEST" ||
        value === "W"
    ) {

        return "W";

    }


    if (
        value === "NORTH-WEST" ||
        value === "NORTHWEST" ||
        value === "NW"
    ) {

        return "NW";

    }


    return null;

}


// =====================================================
// DIRECTION NAME
// =====================================================

function directionName(
    direction
) {

    if (direction === "N") return "NORTH";
    if (direction === "NE") return "NORTH-EAST";
    if (direction === "E") return "EAST";
    if (direction === "SE") return "SOUTH-EAST";
    if (direction === "S") return "SOUTH";
    if (direction === "SW") return "SOUTH-WEST";
    if (direction === "W") return "WEST";
    if (direction === "NW") return "NORTH-WEST";

    return "UNKNOWN";

}


// =====================================================
// DIRECTION ICON
// =====================================================

function directionIcon(
    direction
) {

    if (direction === "N") return "⬆️";
    if (direction === "NE") return "↗️";
    if (direction === "E") return "➡️";
    if (direction === "SE") return "↘️";
    if (direction === "S") return "⬇️";
    if (direction === "SW") return "↙️";
    if (direction === "W") return "⬅️";
    if (direction === "NW") return "↖️";

    return "📍";

}


// =====================================================
// GET STATUS
// =====================================================

function getDirectionStatus(
    delay
) {

    if (
        delay >= 300
    ) {

        return {

            level:
                "HEAVY",

            icon:
                "🔴",

            text:
                "Heavy"

        };

    }


    if (
        delay >= 120
    ) {

        return {

            level:
                "MODERATE",

            icon:
                "🟠",

            text:
                "Moderate"

        };

    }


    return {

        level:
            "NORMAL",

        icon:
            "🟢",

        text:
            "Normal"

    };

}


// =====================================================
// CLEAR DIRECTION
// =====================================================

function clearTrafficDirection() {

    if (compass) {

        compass.classList.remove(
            "direction-n",
            "direction-e",
            "direction-s",
            "direction-w"
        );

    }


    if (trafficSector) {

        trafficSector.className =
            "traffic-sector";

        trafficSector.innerHTML =
            "Waiting for traffic data...";

    }


    if (trafficDirectionInfo) {

        trafficDirectionInfo.className =
            "traffic-direction-info";

        trafficDirectionInfo.innerHTML =
            "📍 Traffic direction will appear here.";

    }

}


// =====================================================
// UPDATE COMPASS
// =====================================================

function updateCompass(
    worstDirection
) {

    if (!compass) {

        return;

    }


    compass.classList.remove(
        "direction-n",
        "direction-e",
        "direction-s",
        "direction-w"
    );


    const direction =
        normalizeDirection(
            worstDirection
        );


    if (!direction) {

        return;

    }


    if (direction === "N") {

        compass.classList.add(
            "direction-n"
        );

    }

    else if (direction === "E") {

        compass.classList.add(
            "direction-e"
        );

    }

    else if (direction === "S") {

        compass.classList.add(
            "direction-s"
        );

    }

    else if (direction === "W") {

        compass.classList.add(
            "direction-w"
        );

    }

}


// =====================================================
// UPDATE TRAFFIC DIRECTION
// =====================================================

function updateTrafficDirection(
    traffic,
    monitoring
) {

    if (
        !traffic
    ) {

        clearTrafficDirection();

        return;

    }


    // =================================================
    // GET DIRECTION RESULTS
    // =================================================

    let directions = [];


    if (
        monitoring &&
        Array.isArray(
            monitoring.directions
        )
    ) {

        directions =
            monitoring.directions;

    }


    // =================================================
    // UPDATE COMPASS
    // =================================================

    updateCompass(
        traffic.worstDirection
    );


    // =================================================
    // BUILD FOUR DIRECTIONS
    // =================================================

    const directionOrder = [

        {
            key: "N",
            name: "NORTH"
        },

        {
            key: "E",
            name: "EAST"
        },

        {
            key: "S",
            name: "SOUTH"
        },

        {
            key: "W",
            name: "WEST"
        }

    ];


    const directionCards =
        directionOrder.map(

            direction => {

                const result =
                    directions.find(

                        item =>

                            normalizeDirection(
                                item.direction
                            ) ===
                            direction.key

                    );


                const delay =
                    result &&
                    typeof result.delayInSeconds ===
                        "number"

                        ? result.delayInSeconds

                        : 0;


                const delayMinutes =
                    Math.round(
                        delay / 60
                    );


                const status =
                    getDirectionStatus(
                        delay
                    );


                return {

                    ...direction,

                    delay,

                    delayMinutes,

                    status

                };

            }

        );


    // =================================================
    // DISPLAY FOUR DIRECTION STATUS
    // =================================================

    if (trafficSector) {

        trafficSector.className =
            "traffic-sector";


        trafficSector.innerHTML = `

            <div style="
                font-size:16px;
                font-weight:700;
                margin-bottom:12px;
            ">

                🧭 Traffic Around You

            </div>


            <div style="
                display:grid;
                grid-template-columns:
                    repeat(2, 1fr);
                gap:8px;
                text-align:left;
            ">


                ${directionCards.map(

                    item => `

                        <div style="
                            padding:8px;
                            border-radius:8px;
                            background:#f8f9fa;
                            border:1px solid #e5e7eb;
                        ">

                            ${directionIcon(
                                item.key
                            )}

                            <strong>
                                ${item.name}
                            </strong>

                            <br>

                            <span>
                                ${item.status.icon}
                                ${item.status.text}
                            </span>

                            <br>

                            <small>
                                Delay:
                                ${item.delayMinutes}
                                min
                            </small>

                        </div>

                    `

                ).join("")}


            </div>

        `;

    }


    // =================================================
    // WORST DIRECTION
    // =================================================

    const worstDirection =
        normalizeDirection(
            traffic.worstDirection
        );


    const worstDirectionName =
        directionName(
            worstDirection
        );


    const worstDelay =
        Number(
            traffic.delayInSeconds || 0
        );


    const worstDelayMinutes =
        Math.round(
            worstDelay / 60
        );


    const overallLevel =
        String(
            traffic.level ||
            "NORMAL"
        ).toUpperCase();


    // =================================================
    // NORMAL
    // =================================================

    if (
        overallLevel ===
        "NORMAL"
    ) {

        if (trafficDirectionInfo) {

            trafficDirectionInfo.className =
                "traffic-direction-info normal";


            trafficDirectionInfo.innerHTML = `

                🟢 <strong>
                    Traffic is currently normal
                </strong>

                <br><br>

                🧭 All monitored directions
                are currently normal.

                <br>

                📏 Monitoring radius:
                <strong>
                    5 km
                </strong>

            `;

        }


        return;

    }


    // =================================================
    // MODERATE
    // =================================================

    if (
        overallLevel ===
        "MODERATE"
    ) {

        if (trafficDirectionInfo) {

            trafficDirectionInfo.className =
                "traffic-direction-info moderate";


            trafficDirectionInfo.innerHTML = `

                🟠 <strong>
                    Moderate traffic detected
                </strong>

                <br><br>

                🧭 Most affected direction:
                <strong>
                    ${worstDirectionName}
                </strong>

                <br>

                ⏱️ Estimated delay:
                <strong>
                    ${worstDelayMinutes}
                    min
                </strong>

                <br>

                📏 Monitoring radius:
                <strong>
                    5 km
                </strong>

            `;

        }


        return;

    }


    // =================================================
    // HEAVY
    // =================================================

    if (
        overallLevel ===
        "HEAVY"
    ) {

        if (trafficDirectionInfo) {

            trafficDirectionInfo.className =
                "traffic-direction-info heavy";


            trafficDirectionInfo.innerHTML = `

                🚨 <strong>
                    Heavy traffic detected
                </strong>

                <br><br>

                🧭 Most affected direction:
                <strong>
                    ${worstDirectionName}
                </strong>

                <br>

                ⏱️ Estimated delay:
                <strong>
                    ${worstDelayMinutes}
                    min
                </strong>

                <br>

                📏 Monitoring radius:
                <strong>
                    5 km
                </strong>

                <br><br>

                ⚠️ Consider checking
                the alternate route recommendation.

            `;

        }


        return;

    }

}


// =====================================================
// CHECK TRAFFIC
// =====================================================

let directionCheckInProgress = false;

async function checkTrafficDirection() {

    if (directionCheckInProgress) {
        return;
    }

    directionCheckInProgress = true;

    try {

        const response =
            await fetch(

                `${TRAFFIC_DIRECTION_BACKEND}/api/traffic-monitor`,

                {

                    cache:
                        "no-store"

                }

            );


        if (
            !response.ok
        ) {

            return;

        }


        const data =
            await response.json();


        console.log(
            "🧭 Direction Traffic:",
            data
        );


        if (
            !data ||
            !data.traffic
        ) {

            return;

        }


        updateTrafficDirection(

            data.traffic,

            data.monitoring

        );

    }

        catch (error) {

        console.error(
            "Traffic direction UI error:",
            error
        );

    }
    finally {

        directionCheckInProgress = false;

    }

}

// =====================================================
// INITIAL CHECK
// =====================================================

setTimeout(

    function() {

        checkTrafficDirection();

    },

    2000

);


// =====================================================
// CHECK EVERY 3 MINUTES (shared backend route cache reduces duplicate requests)
// =====================================================

setInterval(

    function() {

        checkTrafficDirection();

    },

    180000

);