# Postre Food Products
# Messenger Ordering & Reservation System
## Complete Project Plan

---

# 1. PROJECT GOAL

Build a custom, no-AI Messenger ordering and reservation system for Postre Food Products.

Target operating cost: ₱0/month where practical.

The system will allow customers to:

- Browse the menu through Facebook Messenger
- Browse discounted packages
- Customize package dishes
- Select M/L variants
- Add products to a cart
- Automatically calculate the total
- Choose delivery or pickup
- Select reservation date and time
- Submit an order
- Receive order/reservation confirmations

The admin will be able to:

- Manage the menu
- Manage M/L prices
- Manage packages
- Configure package combinations
- Manage orders
- Manage reservations
- Manage customers
- Manage delivery areas and fees
- Manage business hours
- Manage closed dates
- Manage time-slot capacity
- Manage payment/order status

No AI is required.

---

# 2. SYSTEM OVERVIEW

CUSTOMER
    ↓
FACEBOOK MESSENGER
    ↓
MESSENGER WEBHOOK
    ↓
BACKEND API
    ↓
BUSINESS LOGIC
    ↓
DATABASE
    ↑
ADMIN PANEL

The Messenger interface and Admin Panel will use the same backend and database.

---

# 3. CUSTOMER MESSENGER EXPERIENCE

The customer interacts using:

- Buttons
- Quick replies
- Carousels
- Menus
- Structured conversation states

No AI chatbot is necessary.

## Main Menu

Welcome to Postre Food Products!

Options:

- 🛒 Order Now
- 🔥 Packages
- 📋 Menu
- 📅 Reservation
- ☎️ Contact Us

---

# 4. REGULAR MENU

## Categories

Example categories:

- Chicken
- Pork
- Beef
- Noodles
- Bilao
- Desserts

Categories must be manageable from the Admin Panel.

## Product Carousel

Each product can display:

- Photo
- Name
- Description
- M price
- L price
- Order button

Example:

Chicken BBQ

M ₱450
L ₱650

[ORDER]

---

# 5. PRODUCT VARIANTS

Products support variants.

Initial variants:

- M
- L

Example:

Chicken BBQ

M → ₱450
L → ₱650

Serving size is NOT included.

The system should be designed so additional variants can be added later without redesigning the product system.

---

# 6. REGULAR ORDER FLOW

MENU
 ↓
CATEGORY
 ↓
PRODUCT
 ↓
SIZE
 ↓
QUANTITY
 ↓
ADD TO CART
 ↓
ADD MORE / CHECKOUT

Example:

Chicken BBQ

[M ₱450] [L ₱650]

Quantity:
[-] 2 [+]

[ADD TO CART]

---

# 7. DISCOUNTED PACKAGES

Packages are displayed separately from the regular menu.

Example:

DISCOUNTED PACKAGES

Family Package
₱2,000
Choose 4 dishes

Party Package
₱2,500
Choose 5 dishes

Packages can have:

- 4 selections
- 5 selections
- Different base prices
- Different allowed dishes
- Different upgrade prices

---

# 8. CUSTOMIZABLE PACKAGES

Customers can change the dishes included in a package.

Example:

FAMILY PACKAGE
₱2,000

Choose 4 dishes:

1. Chicken BBQ
2. Pork Menudo
3. Pancit
4. Chopsuey

[CHANGE #1]
[CHANGE #2]
[CHANGE #3]
[CHANGE #4]

[DONE]

When a customer changes a dish, the system displays the allowed replacement options.

---

# 9. PACKAGE UPGRADES

Packages can have additional charges.

Example:

Package A
₱2,000

Included:

- Chicken BBQ
- Pork Menudo
- Pancit
- Chopsuey

Upgrades:

- Beef Caldereta +₱150
- Beef Steak +₱250

Example calculation:

Package base       ₱2,000
Upgrade              +₱250
---------------------------
TOTAL               ₱2,250

---

# 10. PACKAGE SIZE HANDLING

If package selections support M/L:

Example:

Chicken BBQ

M = Included
L = +₱100

The package pricing engine automatically applies the adjustment.

---

# 11. SHOPPING CART

Regular products and packages can be combined in the same cart.

Example:

YOUR CART

Family Package × 1
₱2,150

Chicken Bilao L × 2
₱1,300

Palabok M × 1
₱650

----------------
Subtotal       ₱4,100
Delivery         ₱100
----------------
TOTAL          ₱4,200

[ADD MORE]
[EDIT]
[REMOVE]
[CHECKOUT]

---

# 12. AUTOMATIC PRICING ENGINE

The server calculates the authoritative final amount.

Formula:

Product prices
+
Package base prices
+
Size upgrades
+
Package substitutions/upgrades
+
Delivery
-
Discounts
=
FINAL TOTAL

Important:

Never trust prices sent from Messenger or the client.

The backend must retrieve the current authoritative price from the database.

---

# 13. CUSTOMER CHECKOUT

Collect only necessary information.

Required:

- Name
- Mobile number
- Delivery or Pickup
- Address if delivery
- Date
- Time
- Payment method
- Special instructions

---

# 14. RESERVATION SYSTEM

Customers select a date and available time.

Example:

SELECT DATE

[Sept 1]
[Sept 2]
[Sept 3]
[Sept 4]

Then:

AVAILABLE TIMES

[10:00 AM]
[12:00 PM]
[2:00 PM]
[4:00 PM]
[6:00 PM]

The backend checks availability before confirming the reservation.

---

# 15. RESERVATION CAPACITY

Admin controls the maximum number of reservations/orders per time slot.

Example:

10:00 AM → 3 / 5
12:00 PM → 5 / 5 FULL
2:00 PM  → 1 / 5
4:00 PM  → 0 / 5
6:00 PM  → 4 / 5

If a slot is full, Messenger must not allow the customer to select it.

Alternative available times should be shown.

---

# 16. BUSINESS SCHEDULE

Admin can configure business hours.

Example:

Monday     10AM–7PM
Tuesday    10AM–7PM
Wednesday  10AM–7PM
Thursday   10AM–7PM
Friday     10AM–7PM
Saturday   10AM–7PM
Sunday     Closed

Admin can also configure:

- Closed dates
- Holidays
- Minimum advance booking
- Maximum advance booking
- Available time slots
- Maximum orders per slot

---

# 17. CLOSED DATES

Admin can mark specific dates as unavailable.

Example:

September 6  → CLOSED
September 15 → CLOSED
December 25  → CLOSED

Customers cannot reserve closed dates.

---

# 18. DOUBLE-BOOKING PROTECTION

Two customers attempting to reserve the last available slot simultaneously must not both succeed.

Use:

- Database transactions
- Appropriate row locking
- Unique constraints where applicable
- Server-side availability checks

Do not rely only on frontend availability checks.

---

# 19. ORDER CONFIRMATION

Before submission, show:

ORDER SUMMARY

Family Package       ₱2,150
Chicken Bilao L ×2   ₱1,300
Palabok M ×1           ₱650

Subtotal             ₱4,100
Delivery               ₱100

TOTAL                ₱4,200

Date: Sept 5
Time: 3:00 PM
Method: Delivery

[EDIT]
[PLACE ORDER]

After submission:

ORDER RECEIVED!

Order #PP-1024

We'll confirm your order shortly.

Thank you!

---

# 20. ADMIN PANEL

The Admin Panel is the main control center.

Navigation:

- 📊 Dashboard
- 🍽️ Menu
- 🔥 Packages
- 🛒 Orders
- 📅 Reservations
- 👥 Customers
- 🚚 Delivery
- ⚙️ Settings

---

# 21. MODERN UI DESIGN

The Admin Panel should have a modern, polished UI.

Design goals:

- Modern
- Clean
- Premium
- Responsive
- Mobile-first
- Fast
- Touch-friendly
- Professional

Visual style:

- Rounded cards
- Clean typography
- Large food images
- Subtle shadows
- Status badges
- Search
- Filters
- Modal dialogs
- Toast notifications
- Loading states
- Smooth transitions
- Optional dark mode

The UI should look like a modern SaaS dashboard rather than an old-fashioned CRUD application.

---

# 22. MOBILE ADMIN UI

The Admin Panel must work well on phones.

Mobile navigation can use:

- Bottom navigation
- Compact hamburger menu
- Touch-friendly controls

Example sections:

Dashboard
Orders
Reservations
Menu
Settings

The owner should be able to manage the business from a phone.

---

# 23. ADMIN DASHBOARD

Dashboard should show:

- Today's orders
- Pending orders
- Confirmed orders
- Today's reservations
- Today's sales
- Upcoming reservations
- Recent orders

Example:

POSTRE ADMIN

Good evening!

Orders
12

Sales
₱18,450

Today's Reservations:

10:00 AM  Juan Dela Cruz   Confirmed
12:00 PM  Maria Santos     Pending
3:00 PM   Available
5:00 PM   Pedro Cruz       Confirmed

---

# 24. MENU MANAGEMENT

Admin can:

- Add product
- Edit product
- Delete/disable product
- Change name
- Change category
- Change description
- Upload/change photo
- Add/remove variants
- Change M price
- Change L price
- Mark product unavailable
- Reorder products

Example:

Chicken BBQ

M   ₱450
L   ₱650

● Available

[EDIT]

No code modification should be necessary for normal menu changes.

---

# 25. PACKAGE MANAGEMENT

Admin can create and edit packages.

Package fields:

- Package name
- Description
- Photo
- Base price
- Number of selections
- Active/inactive

Example:

Package Name:
Family Package

Base Price:
₱2,000

Number of selections:
4

---

# 26. PACKAGE BUILDER

Admin can define the package slots.

Example:

Slot 1
    Chicken BBQ
    Fried Chicken
    Chicken Teriyaki

Slot 2
    Pork BBQ
    Pork Menudo
    Hamonado

Slot 3
    Pancit
    Palabok
    Bihon

Slot 4
    Chopsuey
    Mixed Vegetables

Admin can add/remove products from each slot.

---

# 27. PACKAGE UPGRADE BUILDER

Admin can configure upgrade prices.

Example:

Beef Caldereta +₱150
Beef Steak     +₱250

This allows the pricing engine to calculate package upgrades automatically.

---

# 28. RESERVATION MANAGEMENT

Admin gets a calendar interface.

Example:

September 2026

MON TUE WED THU FRI SAT SUN
 1   2   3   4   5   6   7
 🟢  🟢  🟡  🔴  🟢  🟢  🟢

Legend:

🟢 Available
🟡 Partially booked
🔴 Fully booked
⚫ Closed

Clicking a date opens its reservations.

---

# 29. RESERVATION DETAILS

Example:

September 5

10:00 AM
Juan Dela Cruz
Confirmed

12:00 PM
Maria Santos
Pending

3:00 PM
Available

5:00 PM
Pedro Cruz
Confirmed

Admin can see:

- Customer
- Order
- Amount
- Date
- Time
- Status
- Contact information
- Notes

---

# 30. RESERVATION ACTIONS

Admin can:

- Create reservation
- Edit reservation
- Confirm reservation
- Cancel reservation
- Reschedule reservation
- Mark completed
- Search reservations
- Filter reservations
- View upcoming reservations

---

# 31. MANUAL RESERVATIONS

Admin must be able to create a reservation manually.

This is important for customers who:

- Call
- Text
- Visit
- Message another account

Example:

NEW RESERVATION

Customer: __________
Phone: _____________
Date: ______________
Time: ______________
Order: _____________
Notes: ______________

[CREATE]

Manual reservations must use the same reservation system/database as Messenger reservations.

---

# 32. ORDER MANAGEMENT

Admin sees all orders.

Example:

#1024
Juan Dela Cruz
₱4,200
Sept 5 • 3 PM

Pending

[CONFIRM]
[REJECT]

---

# 33. ORDER STATUS

Primary workflow:

PENDING
    ↓
CONFIRMED
    ↓
PREPARING
    ↓
READY
    ↓
COMPLETED

Alternative:

PENDING → CANCELLED

---

# 34. MESSENGER STATUS NOTIFICATIONS

Order status changes can trigger Messenger messages.

Examples:

Confirmed:
"Your order has been confirmed."

Preparing:
"Your order is now being prepared."

Ready:
"Your order is ready!"

Reservation confirmations and cancellations can also generate automatic messages.

---

# 35. DELIVERY MANAGEMENT

Admin can configure delivery areas and fees.

Example:

Magarao      ₱50
Naga City    ₱100
Other Area   ₱150

The system automatically applies the appropriate delivery fee.

Future options:

- Free delivery threshold
- Minimum delivery order
- Delivery radius
- More detailed delivery zones

---

# 36. CUSTOMER MANAGEMENT

Store:

- Messenger ID
- Name
- Phone
- Address
- Order history
- Total orders
- Total spending

Admin can view previous orders.

---

# 37. PAYMENT — V1

Keep payment simple initially.

Methods:

- GCash
- Bank Transfer
- Cash

Payment statuses:

UNPAID
PAYMENT SUBMITTED
PAID

No payment gateway is required for V1.

---

# 38. DATABASE ARCHITECTURE

Core tables:

admins

customers

categories

products
product_variants

packages
package_slots
package_options

carts
cart_items
cart_package_items

orders
order_items
order_package_items

reservations

delivery_areas

business_hours
blocked_dates
time_slots

payments

order_status_history

---

# 39. DATABASE PRINCIPLES

Products should be centralized.

Packages should reference products instead of duplicating product information.

For example:

If Chicken BBQ changes from:

M ₱450

to:

M ₱475

the product data is updated centrally.

The package system should reference the product rather than creating a separate copy of Chicken BBQ.

---

# 40. BACKEND ARCHITECTURE

Messenger Webhook
        ↓
Messenger Controller
        ↓
Conversation State
        ↓
Business Services
        ↓
Database

Business services:

- Product Service
- Package Service
- Pricing Service
- Cart Service
- Order Service
- Reservation Service
- Customer Service
- Delivery Service

Business logic must remain separate from Messenger handlers.

---

# 41. CONVERSATION STATE MACHINE

Do not build Messenger using one huge collection of if/else statements.

Use explicit conversation states.

Example:

MAIN_MENU

ORDER
 ├ CATEGORY
 ├ PRODUCT
 ├ VARIANT
 ├ QUANTITY
 └ CART

PACKAGE
 ├ PACKAGE_LIST
 ├ PACKAGE_DETAILS
 ├ SELECT_SLOT
 ├ SELECT_OPTION
 └ PACKAGE_REVIEW

CHECKOUT
 ├ NAME
 ├ PHONE
 ├ DELIVERY
 ├ ADDRESS
 ├ DATE
 ├ TIME
 ├ PAYMENT
 └ CONFIRMATION

This makes the Messenger system easier to debug and maintain.

---

# 42. SECURITY

## Admin

Implement:

- Password hashing
- Authentication
- Secure sessions/tokens
- HTTPS
- Input validation
- Rate limiting

## Messenger

Implement:

- Webhook verification
- Event validation
- Server-side price calculation
- Database transactions
- Reservation locking
- Product/package validation

Never trust client-supplied:

- Prices
- Totals
- Product information
- Package information
- Reservation availability

---

# 43. TECHNOLOGY STACK

Recommended backend:

Node.js
TypeScript
Fastify or Express

Recommended database:

PostgreSQL

SQLite can be used for an MVP if hosting makes it more convenient.

Recommended Admin UI:

React / Next.js

Messenger:

Meta Messenger Platform

---

# 44. HOSTING GOAL

Target:

₱0/month

Use free tiers where practical.

The architecture should avoid unnecessary paid SaaS services.

Potential costs/limits from Meta, hosting providers, messaging infrastructure, or higher usage should be checked before production deployment.

---

# 45. DEVELOPMENT PHASE 1 — FOUNDATION

Build:

- Project structure
- Backend
- Database
- Database migrations
- Authentication
- Admin layout
- Environment configuration
- Logging
- Error handling

---

# 46. DEVELOPMENT PHASE 2 — MENU

Build:

- Categories
- Products
- M/L variants
- Photos
- Pricing
- Availability
- Product CRUD
- Category CRUD
- Product ordering/reordering
- Admin menu interface

---

# 47. DEVELOPMENT PHASE 3 — PACKAGES

Build:

- Package CRUD
- 4-selection packages
- 5-selection packages
- Package slots
- Allowed products
- Package substitutions
- M/L rules
- Upgrade pricing
- Package builder UI
- Package preview

---

# 48. DEVELOPMENT PHASE 4 — CART & PRICING

Build:

- Cart
- Add item
- Remove item
- Edit item
- Quantity
- Product calculation
- Package calculation
- Size calculation
- Upgrade calculation
- Delivery calculation
- Discount calculation
- Final total

All final calculations happen server-side.

---

# 49. DEVELOPMENT PHASE 5 — ORDERS

Build:

- Checkout
- Customer details
- Delivery/pickup
- Order creation
- Order number generation
- Order status
- Payment status
- Order history
- Admin order management

---

# 50. DEVELOPMENT PHASE 6 — RESERVATIONS

Build:

- Calendar
- Available dates
- Closed dates
- Time slots
- Capacity
- Availability checking
- Reservation creation
- Reservation editing
- Reservation cancellation
- Rescheduling
- Conflict prevention
- Admin reservation management

---

# 51. DEVELOPMENT PHASE 7 — MESSENGER

Build:

- Meta application
- Facebook Page connection
- Webhook
- Webhook verification
- Messenger messages
- Buttons
- Quick replies
- Carousels
- Menu flow
- Product flow
- Package flow
- Cart flow
- Checkout flow
- Reservation flow

---

# 52. DEVELOPMENT PHASE 8 — NOTIFICATIONS

Build:

- Order confirmation
- Reservation confirmation
- Order status notifications
- Reservation cancellation
- Order cancellation
- Ready notification

---

# 53. DEVELOPMENT PHASE 9 — TESTING

Test:

- Product ordering
- M/L selection
- Quantity
- Packages
- 4-item packages
- 5-item packages
- Package substitutions
- Package upgrades
- Cart
- Pricing
- Delivery
- Checkout
- Reservation
- Full time slots
- Closed dates
- Simultaneous reservations
- Order cancellation
- Admin changes
- Messenger conversation recovery

---

# 54. V1 CUSTOMER FEATURES

- Messenger ordering
- Menu categories
- Product carousel
- M/L variants
- Discounted packages
- 4-item packages
- 5-item packages
- Custom package selections
- Package substitutions
- Package upgrades
- Automatic calculations
- Shopping cart
- Delivery/pickup
- Date selection
- Time selection
- Reservation
- Order confirmation
- Reservation confirmation
- Status notifications

---

# 55. V1 ADMIN FEATURES

- Modern responsive UI
- Dashboard
- Menu management
- Category management
- M/L price management
- Package management
- Package builder
- Order management
- Reservation calendar
- Reservation management
- Manual reservations
- Customer management
- Delivery management
- Business hours
- Closed dates
- Time-slot capacity
- Payment status
- Order status
- Reservation status

---

# 56. FUTURE FEATURES

After V1 is stable:

- Sales reports
- Analytics
- Promo codes
- Special discounts
- Online payment
- Payment proof upload
- Inventory
- Receipts
- Customer website
- QR ordering
- Promotions/broadcasts
- Automated reminders
- Advanced delivery management
- Multiple admin accounts
- Staff permissions

AI remains optional and is not required for the core system.

---

# 57. IMPORTANT ARCHITECTURE PRINCIPLE

Do NOT build the entire system around Messenger.

Build the business engine first.

Architecture:

                    DATABASE
                       ▲
                       │
                BUSINESS LOGIC
                       │
          ┌────────────┴────────────┐
          │                         │
     ADMIN PANEL                MESSENGER
          │                         │
   Manage everything          Customer orders

Messenger and Admin Panel should both use the same backend services.

This allows the system to later support:

- Messenger
- Website
- QR ordering
- Other customer interfaces

without rewriting the core business logic.

---

# 58. RECOMMENDED BUILD ORDER

1. Database schema
2. Backend architecture
3. Pricing engine
4. Package engine
5. Admin authentication
6. Menu management
7. Package management
8. Cart/order engine
9. Reservation engine
10. Modern Admin UI
11. Messenger integration
12. Notifications
13. End-to-end testing
14. Deployment

---

# 59. FINAL V1 ARCHITECTURE

                    CUSTOMER
                       │
                       ▼
              FACEBOOK MESSENGER
                       │
                       ▼
              MESSENGER WEBHOOK
                       │
                       ▼
                 BACKEND API
                       │
          ┌────────────┴────────────┐
          ▼                         ▼
      DATABASE                 ADMIN PANEL
          │                         │
          │                  Menu / Packages
          │                  Orders
          │                  Reservations
          │                  Customers
          │                  Delivery
          │                  Settings
          │
          └───────────────┐
                          ▼
                    BUSINESS ENGINE
                          │
              ┌───────────┼───────────┐
              ▼           ▼           ▼
           Pricing      Orders    Reservations

---

# 60. FINAL OBJECTIVE

Create a complete small-business ordering system where:

Customers can order through Facebook Messenger.

They can browse the regular menu.

They can choose M/L variants.

They can browse discounted packages.

They can customize the dishes inside 4-item and 5-item packages.

The system automatically calculates package upgrades, product prices, delivery, discounts, and the final total.

Customers can select delivery or pickup.

Customers can select an available reservation date and time.

The system prevents double-booking.

The owner can manag
