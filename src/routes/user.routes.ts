import { Router } from 'express';
import { PERMISSIONS } from '../constants/permissions';
import * as userController from '../controllers/user.controller';
import { authenticate } from '../middlewares/authenticate';
import { requirePermission } from '../middlewares/requirePermission';

const { USER, ROLE } = PERMISSIONS;

export const userRoutes = Router();
userRoutes.use(authenticate());

userRoutes.get('/', requirePermission(USER.LIST), userController.list);
userRoutes.get('/:id', requirePermission(USER.VIEW), userController.get);
userRoutes.post('/', requirePermission(USER.CREATE), userController.create);
userRoutes.put('/:id/roles', requirePermission(USER.UPDATE), userController.assignRoles);
userRoutes.patch('/:id/status', requirePermission(USER.UPDATE), userController.setStatus);
userRoutes.post('/:id/reset-password', requirePermission(USER.UPDATE), userController.resetPassword);
userRoutes.delete('/:id', requirePermission(USER.DELETE), userController.remove);

export const roleRoutes = Router();
roleRoutes.use(authenticate());

roleRoutes.get('/', requirePermission(ROLE.LIST), userController.listRoles);
roleRoutes.get('/:id', requirePermission(ROLE.VIEW), userController.getRole);
