import express from "express";
import { authMiddleware, login, refresh } from "./auth";

const app = express();
app.use(express.json());

app.post("/auth/login", login);
app.post("/auth/refresh", refresh);

app.get("/protected", authMiddleware, (req, res) => {
	res.json({ message: "Protected route", user: req.user });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;
