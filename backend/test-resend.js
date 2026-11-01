require("dotenv").config();

async function testEmail() {
    const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            from: process.env.EMAIL_FROM,
            to: [process.env.RESEND_TEST_TO],
            subject: "Smart Traffic OTP Test",
            text: "Your Smart Traffic email verification system is working!"
        })
    });

    const result = await response.json();
    console.log("Status:", response.status);
    console.log("Result:", result);
}

testEmail().catch(console.error);