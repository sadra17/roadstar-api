const ALL_SLOTS = [
  "9:00 AM",  "9:40 AM",
  "10:00 AM", "10:40 AM",
  "11:00 AM", "11:40 AM",
  "12:00 PM",
  "1:00 PM",  "1:40 PM",
  "2:00 PM",  "2:40 PM",
  "3:00 PM",  "3:40 PM",
  "4:00 PM",
];

const toMinutes = (slot) => {
  const [time, period] = slot.split(" ");
  let [h, m] = time.split(":").map(Number);
  if (period === "PM" && h !== 12) h += 12;
  if (period === "AM" && h === 12) h = 0;
  return h * 60 + m;
};

module.exports = { ALL_SLOTS, toMinutes };
